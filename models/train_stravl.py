"""Train a shared cold-user preference model on Stravl Yes/No responses.

Stravl has no child ages at 3-5 / 6-8 / 9-11 resolution. Age-band weights
are therefore deliberately outside this model until local age labels exist.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import torch
from torch import nn
from torch.nn import functional as F


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "processed" / "stravl"


class PreferenceModel(nn.Module):
    def __init__(self, feature_count: int, destination_count: int, dimension: int = 32):
        super().__init__()
        self.user_projection = nn.Linear(feature_count, dimension, bias=False)
        self.destination_embedding = nn.Embedding(destination_count, dimension)
        self.destination_bias = nn.Embedding(destination_count, 1)
        self.global_bias = nn.Parameter(torch.zeros(()))
        nn.init.normal_(self.destination_embedding.weight, std=0.05)
        nn.init.normal_(self.user_projection.weight, std=0.05)
        nn.init.zeros_(self.destination_bias.weight)

    def forward(self, user_features: torch.Tensor, destination_ids: torch.Tensor) -> torch.Tensor:
        user_vector = self.user_projection(user_features)
        destination_vector = self.destination_embedding(destination_ids)
        return (
            (user_vector * destination_vector).sum(dim=-1) / math.sqrt(destination_vector.shape[-1])
            + self.destination_bias(destination_ids).squeeze(-1)
            + self.global_bias
        )


def load_data() -> tuple[np.ndarray, dict[str, dict[str, np.ndarray]], list[str], int]:
    profiles = pq.read_table(DATA / "profiles.parquet").to_pylist()
    interactions = pq.read_table(DATA / "interactions.parquet").to_pydict()
    field_names = [name for name in profiles[0] if name not in ("user_id", "split")]
    assert "form_b" not in field_names
    vocabulary = sorted({
        f"{field}={value}"
        for profile in profiles if profile["split"] == "train"
        for field in field_names for value in profile[field]
    })
    feature_index = {value: index for index, value in enumerate(vocabulary)}
    users = {profile["user_id"]: index for index, profile in enumerate(profiles)}
    user_features = np.zeros((len(profiles), len(vocabulary)), dtype=np.float32)
    for index, profile in enumerate(profiles):
        for field in field_names:
            for value in profile[field]:
                feature = feature_index.get(f"{field}={value}")
                if feature is not None:
                    user_features[index, feature] = 1.0

    arrays = {
        "user": np.fromiter((users[value] for value in interactions["user_id"]), dtype=np.int32),
        "item": np.asarray(interactions["destination_id"], dtype=np.int32),
        "label": np.asarray([1 if value == "yes" else 0 for value in interactions["response"]], dtype=np.float32),
        "split": np.asarray(interactions["split"]),
        "response": np.asarray(interactions["response"]),
    }
    datasets = {}
    for split in ("train", "validation", "test"):
        mask = (arrays["split"] == split) & (arrays["response"] != "maybe")
        datasets[split] = {key: arrays[key][mask] for key in ("user", "item", "label")}
    destination_count = sum(1 for _ in (DATA / "destinations.csv").open(encoding="utf-8")) - 1
    return user_features, datasets, vocabulary, destination_count


def auc(labels: np.ndarray, scores: np.ndarray) -> float | None:
    positives = int(labels.sum())
    negatives = len(labels) - positives
    if not positives or not negatives:
        return None
    order = np.argsort(scores, kind="stable")
    sorted_scores = scores[order]
    sorted_labels = labels[order]
    negative_before = 0
    wins = 0.0
    start = 0
    while start < len(labels):
        end = start + 1
        while end < len(labels) and sorted_scores[end] == sorted_scores[start]:
            end += 1
        group_positive = int(sorted_labels[start:end].sum())
        group_negative = end - start - group_positive
        wins += group_positive * (negative_before + group_negative / 2)
        negative_before += group_negative
        start = end
    return wins / (positives * negatives)


def ndcg_at_10(users: np.ndarray, labels: np.ndarray, scores: np.ndarray) -> float | None:
    groups: dict[int, list[int]] = defaultdict(list)
    for index, user in enumerate(users):
        groups[int(user)].append(index)
    values = []
    for indexes in groups.values():
        y = labels[indexes]
        if not y.any():
            continue
        predicted = y[np.argsort(-scores[indexes], kind="stable")[:10]]
        ideal = np.sort(y)[::-1][:10]
        discount = 1 / np.log2(np.arange(2, len(predicted) + 2))
        ideal_discount = 1 / np.log2(np.arange(2, len(ideal) + 2))
        values.append(float(np.dot(predicted, discount) / np.dot(ideal, ideal_discount)))
    return float(np.mean(values)) if values else None


def metrics(dataset: dict[str, np.ndarray], probabilities: np.ndarray) -> dict:
    labels = dataset["label"]
    clipped = np.clip(probabilities, 1e-7, 1 - 1e-7)
    loss = -np.mean(labels * np.log(clipped) + (1 - labels) * np.log(1 - clipped))
    return {
        "rows": len(labels),
        "positive_rate": float(labels.mean()),
        "log_loss": float(loss),
        "roc_auc": auc(labels, probabilities),
        "observed_ndcg_at_10": ndcg_at_10(dataset["user"], labels, probabilities),
    }


@torch.no_grad()
def predict(model: PreferenceModel, features: torch.Tensor, dataset: dict, device: torch.device) -> np.ndarray:
    model.eval()
    output = []
    for start in range(0, len(dataset["label"]), 16384):
        end = start + 16384
        users = torch.as_tensor(dataset["user"][start:end].copy(), device=device, dtype=torch.long)
        items = torch.as_tensor(dataset["item"][start:end].copy(), device=device, dtype=torch.long)
        output.append(torch.sigmoid(model(features[users], items)).cpu().numpy())
    return np.concatenate(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=8192)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--run-name", default="stravl_shared")
    parser.add_argument("--learning-rate", type=float, default=0.01)
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--lr-patience", type=int, default=2)
    parser.add_argument("--lr-factor", type=float, default=0.5)
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1 or args.patience < 1 or args.lr_patience < 1 or args.learning_rate <= 0:
        parser.error("epochs, batch-size, patience, lr-patience, and learning-rate must be positive")
    if not 0 < args.lr_factor < 1:
        parser.error("lr-factor must be in (0, 1)")
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.run_name):
        parser.error("run-name must contain only letters, digits, underscores, or hyphens")
    checkpoint = ROOT / "models" / "checkpoints" / f"{args.run_name}.pt"
    report_path = ROOT / "models" / "reports" / f"{args.run_name}.json"
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device("cuda" if args.device == "auto" and torch.cuda.is_available() else args.device if args.device != "auto" else "cpu")
    features, datasets, vocabulary, destination_count = load_data()
    feature_tensor = torch.from_numpy(features).to(device)
    train = datasets["train"]
    train_users = torch.as_tensor(train["user"].copy(), device=device, dtype=torch.long)
    train_items = torch.as_tensor(train["item"].copy(), device=device, dtype=torch.long)
    train_labels = torch.as_tensor(train["label"].copy(), device=device)
    model = PreferenceModel(len(vocabulary), destination_count).to(device)
    model.global_bias.data.fill_(float(torch.logit(train_labels.mean().clamp(1e-4, 1 - 1e-4))))
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0.001)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="min", factor=args.lr_factor, patience=args.lr_patience, min_lr=1e-5
    )

    positives = np.bincount(train["item"], weights=train["label"], minlength=destination_count)
    total = np.bincount(train["item"], minlength=destination_count)
    popularity = (positives + 1) / (total + 2)
    baseline = {split: metrics(data, popularity[data["item"]]) for split, data in datasets.items() if split != "train"}
    best_state = None
    best_loss = float("inf")
    best_epoch = 0
    history = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        shuffled = torch.randperm(len(train_labels), device=device)
        for indexes in shuffled.split(args.batch_size):
            optimizer.zero_grad(set_to_none=True)
            logits = model(feature_tensor[train_users[indexes]], train_items[indexes])
            loss = F.binary_cross_entropy_with_logits(logits, train_labels[indexes])
            loss.backward()
            optimizer.step()
        validation = metrics(datasets["validation"], predict(model, feature_tensor, datasets["validation"], device))
        current_lr = optimizer.param_groups[0]["lr"]
        history.append({"epoch": epoch, "learning_rate": current_lr, **validation})
        print(f"epoch={epoch} lr={current_lr:.6f} validation_log_loss={validation['log_loss']:.5f} auc={validation['roc_auc']:.5f} ndcg10={validation['observed_ndcg_at_10']:.5f}", flush=True)
        if validation["log_loss"] < best_loss:
            best_loss = validation["log_loss"]
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
        elif epoch - best_epoch >= args.patience:
            break
        scheduler.step(validation["log_loss"])

    assert best_state is not None
    model.load_state_dict(best_state)
    model_metrics = {split: metrics(data, predict(model, feature_tensor, data, device)) for split, data in datasets.items() if split != "train"}
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": best_state, "vocabulary": vocabulary, "destination_count": destination_count}, checkpoint)
    report = {
        "model": "shared_survey_destination_embeddings_v1",
        "age_band_weights_trained": False,
        "reason": "Stravl form_a only distinguishes ages 0-19; no 3-5, 6-8, 9-11 labels.",
        "source_interactions_sha256": hashlib.sha256((DATA / "interactions.parquet").read_bytes()).hexdigest(),
        "seed": args.seed,
        "device": str(device),
        "max_epochs": args.epochs,
        "initial_learning_rate": args.learning_rate,
        "early_stopping_patience": args.patience,
        "scheduler_patience": args.lr_patience,
        "scheduler_factor": args.lr_factor,
        "best_epoch": best_epoch,
        "features": len(vocabulary),
        "destination_count": destination_count,
        "baseline_popularity": baseline,
        "trained_model": model_metrics,
        "history": history,
        "checkpoint": str(checkpoint.relative_to(ROOT)),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"best_epoch": best_epoch, "baseline": baseline["test"], "model": model_metrics["test"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
