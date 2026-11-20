/** Доступный Нижний. Вспомогательный снимок DTO v1 для согласования.
 * Источник истины HTTP-контрактов — openapi.json (OpenAPI 3.1.1).
 * Автоматическая генерация этих типов пока не настроена.
 * Не реализация сервиса. Все ID непрозрачные строки, примеры синтетические.
 * Числовые ограничения и обязательные инварианты описаны в integration_contracts_v1.md.
 */
export type ID = string;
export interface SessionResponse { csrf_token: string }
export type ISODate = string; // YYYY-MM-DD
export type Instant = string; // RFC3339 с обязательным UTC offset
export type TimeZone = 'Europe/Moscow';
export type Position = [longitude: number, latitude: number]; // WGS84
export type Mode = 'walk' | 'car';
export type DisplayClass = 'family' | 'neutral' | 'other' | 'unknown';
export type Category = 'museum' | 'event' | 'park' | 'playground' | 'restaurant' |
  'toilet' | 'bench' | 'shelter' | 'landmark' | 'other';

export interface Point { coordinates: Position; label: string | null }
export interface Interval { start_at: Instant; end_at: Instant }
export interface Evidence {
  evidence_id: ID; source_url: string | null;
  source_kind: 'official' | 'osm' | 'review' | 'manual';
  checked_at: Instant; valid_until: Instant | null;
}
export type Fact<T> =
  | { state: 'known'; value: T; evidence_ids: ID[] }
  | { state: 'unknown'; value: null; evidence_ids: ID[] };
export interface Warning {
  code: string; severity: 'info' | 'warning' | 'blocking'; message: string;
  place_id: ID | null; activity_id: ID | null; stop_id: ID | null;
  child_id: ID | null; evidence_ids: ID[];
}
export interface Reason {
  code: string; message: string; child_ids: ID[]; evidence_ids: ID[];
}
export interface FamilyProfile {
  children: { child_id: ID; age_years: number; height_cm: number | null;
    interest_ids: string[] }[];
  adult_count: number; adult_interest_ids: string[];
}
export interface FamilyPolicy {
  // Сумма весов детей = 1; интересы детей имеют равный вклад.
  child_interest_weights: { child_id: ID; weight: number }[];
  activity_balance: {
    mode: 'equal_count_target'; scope: 'trip';
    shared_activity_credit: 'split_equally';
  };
  adult_interest_weight: number; // Предложение MVP: 0.2, дети суммарно 0.8.
}
export interface LoadLimits {
  pace: 'relaxed' | 'standard' | 'intensive';
  max_walk_distance_m_per_day: number | null;
  max_continuous_walk_duration_sec: number | null;
}
export interface DayInput {
  date: ISODate; start_point: Point; end_point: Point;
  available_window: Interval | null;
  duration_budget_sec: number;
  meal_window: Interval | null; rest_budget_sec: number;
}
export interface Selection {
  place_id: ID; activity_id: ID;
  occurrence_id: ID | null; mandatory: boolean;
  preferred_date: ISODate | null;
}
export interface TripInput {
  city_id: 'nizhny_novgorod'; timezone: TimeZone;
  planning_context: 'before_arrival' | 'in_city';
  family: FamilyProfile; load_limits: LoadLimits;
  days: DayInput[]; selections: Selection[];
  request_text: string | null; // Уточняет интересы, не hard constraints.
}

// ML отвечает за эти данные и их происхождение; backend хранит версию каталога.
export interface Place {
  place_id: ID; name: string; location: Point;
  entrance: Point | null; categories: Category[]; display_class: DisplayClass;
  indoor: Fact<boolean>; toilet: Fact<boolean>; shelter: Fact<boolean>;
  seating: Fact<boolean>;
  restaurant: {
    children_menu: Fact<boolean>; small_portions: Fact<boolean>;
    play_area: Fact<boolean>; play_area_min_age: Fact<number>;
    play_area_max_age: Fact<number>; play_area_supervision: Fact<boolean>;
  } | null;
}
export interface DurationEstimate {
  duration_sec: number;
  source: 'official' | 'estimated' | 'user'; evidence_ids: ID[];
}
export interface Activity {
  activity_id: ID; place_id: ID; title: string;
  kind: 'visit' | 'session' | 'meal' | 'rest' | 'utility';
  age_min_years: Fact<number>; age_max_years: Fact<number>;
  recommended_age_min_years: Fact<number>; recommended_age_max_years: Fact<number>;
  height_min_cm: Fact<number>;
  duration: DurationEstimate;
  admission_rule: Fact<'allowed' | 'adult_required' | 'forbidden'>;
  booking_required: Fact<boolean>;
  evidence_ids: ID[];
}
export interface AvailabilityDay {
  date: ISODate;
  // open: полный список интервалов работы за дату; closed: доказанно закрыто.
  state: 'open' | 'closed' | 'unknown';
  visit_windows: Interval[];
  last_entry_at: Instant | null;
  occurrences: {
    occurrence_id: ID; interval: Interval;
    booking_status: 'available' | 'sold_out' | 'unknown';
  }[];
  evidence_ids: ID[];
}
export interface CatalogItem {
  place: Place; activity: Activity; availability: AvailabilityDay[];
}
export interface Candidate extends CatalogItem {
  eligibility: {
    child_id: ID; status: 'eligible' | 'ineligible' | 'unknown';
    reasons: Reason[];
  }[];
  scores: {
    // Интерес ребёнка и взрослых: неотрицательное число без верхней границы.
    // Пригодность этой активности возрастной группе ребёнка: [0,1] или null.
    // Это значение из профиля активности, а не глобальный вес возраста.
    // popularity и final_relevance остаются нормированными в [0, 1].
    child_interest: { child_id: ID; value: number }[];
    child_age_fit: { child_id: ID; value: number | null }[];
    adult_interest: number; popularity: number; final_relevance: number;
  };
  balance_credit: { child_id: ID; value: number }[];
  is_top_place: boolean; reasons: Reason[]; warnings: Warning[];
}

// Внутренний запрос backend -> ML, не browser API.
export interface RecommendationRequest {
  contract_version: '1.0'; request_id: ID;
  trip_id: ID; trip_version: number; catalog_version: string;
  purpose: 'initial' | 'restaurant' | 'along_route' | 'toilet' |
    'rain' | 'playground' | 'rest';
  profile: FamilyProfile; policy: FamilyPolicy; load_limits: LoadLimits;
  days: DayInput[]; selections: Selection[];
  current_day_date: ISODate | null; current_point: Point | null;
  visited_activity_ids: ID[]; excluded_activity_ids: ID[];
  request_text: string | null;
  spatial_scope: {
    center: Point | null; radius_m: number | null;
    route: { type: 'LineString'; coordinates: Position[] } | null;
    corridor_width_m: number | null;
  } | null;
  limit: number;
}
export interface RecommendationResponse {
  contract_version: '1.0'; request_id: ID;
  trip_id: ID; trip_version: number; catalog_version: string;
  model_version: string; generated_at: Instant;
  status: 'complete' | 'partial' | 'no_candidates';
  candidates: Candidate[];
  rejected: { activity_id: ID; reasons: Reason[] }[];
  evidence: Evidence[]; warnings: Warning[];
}

export type StopRef = { kind: 'day_start' } | { kind: 'day_end' } |
  { kind: 'stop'; stop_id: ID };
export interface Stop {
  stop_id: ID; place_id: ID; activity_id: ID; occurrence_id: ID | null;
  title: string; category: Category; location: Point;
  mandatory: boolean; progress: 'planned' | 'visited' | 'skipped';
  duration: DurationEstimate;
  timing: {
    estimated_arrival_at: Instant | null;
    estimated_visit_start_at: Instant | null;
    estimated_departure_at: Instant | null;
    fixed_event_interval: Interval | null;
  };
  balance_credit: { child_id: ID; value: number }[];
  reasons: Reason[]; warnings: Warning[];
}
export interface Leg {
  leg_id: ID; from: StopRef; to: StopRef; mode: Mode;
  status: 'calculated' | 'unavailable';
  distance_m: number | null; travel_duration_sec: number | null;
  geometry: { type: 'LineString'; coordinates: Position[] } | null;
  routing_data_version: string | null; warnings: Warning[];
}
export interface DayPlan {
  date: ISODate;
  presentation: 'relative' | 'clock';
  start_point: Point; end_point: Point;
  available_window: Interval | null;
  feasibility: 'feasible' | 'conditional' | 'infeasible';
  assumptions: string[];
  stops: Stop[]; legs: Leg[];
  totals: {
    walk_distance_m: number | null; walk_duration_sec: number | null;
    visit_duration_sec: number; wait_duration_sec: number | null;
    rest_duration_sec: number; meal_duration_sec: number;
    elapsed_duration_sec: number | null;
  };
  warnings: Warning[];
}
export interface TripView {
  trip_id: ID; version: number; updated_at: Instant;
  status: 'draft' | 'planned' | 'active' | 'completed';
  input: TripInput; policy: FamilyPolicy;
  catalog_version: string; days: DayPlan[];
  evidence: Evidence[];
  family_balance: {
    child_id: ID; target_share: number; planned_credit: number;
    achieved_share: number | null;
  }[];
  warnings: Warning[];
}
export type PlanCommand =
  | { kind: 'generate_plan' }
  | { kind: 'update_trip_input'; input: TripInput }
  | { kind: 'add_activity'; date: ISODate; selection: Selection;
      after_stop_id: ID | null }
  | { kind: 'remove_stop'; date: ISODate; stop_id: ID }
  | { kind: 'replace_stop'; date: ISODate; stop_id: ID; selection: Selection }
  | { kind: 'reorder_stops'; date: ISODate; stop_ids: ID[] }
  | { kind: 'shorten_day'; date: ISODate; target_remaining_duration_sec: number }
  | { kind: 'return_to_hotel'; date: ISODate; hotel_point: Point }
  | { kind: 'start_day'; date: ISODate; point: Point; start_at: Instant };
export interface PreviewRequest {
  expected_version: number; command: PlanCommand;
  current_position: Point | null; observed_at: Instant | null;
}
export interface PlanPreview {
  preview_id: ID; trip_id: ID; base_version: number;
  catalog_version: string; created_at: Instant; expires_at: Instant;
  can_apply: boolean;
  // Условный план применим только после явного принятия этих предупреждений.
  required_acknowledgement_codes: string[];
  proposed_trip: TripView;
  diff: {
    added_stop_ids: ID[]; removed_stop_ids: ID[]; moved_stop_ids: ID[];
    changed_dates: ISODate[];
    walk_delta_sec: number | null; elapsed_delta_sec: number | null;
    finish_delta_sec: number | null; explanations: string[];
  };
  warnings: Warning[];
}
export interface ApplyRequest {
  expected_version: number; acknowledged_warning_codes: string[];
}
export interface ProgressRequest {
  expected_version: number; date: ISODate; stop_id: ID;
  status: 'visited' | 'skipped'; observed_at: Instant;
}
export interface NeedRequest {
  expected_version: number; date: ISODate;
  need: 'tired' | 'toilet' | 'rain' | 'hotel' | 'playground';
  current_position: Point | null; observed_at: Instant | null;
}
export type NeedOption =
  | { option_id: ID; kind: 'candidate'; candidate: Candidate;
      date: ISODate; preview_required: true }
  | { option_id: ID; kind: 'plan_change'; label: string; command: PlanCommand;
      preview_required: true };
export interface NeedResponse {
  trip_id: ID; trip_version: number; options: NeedOption[];
  evidence: Evidence[]; warnings: Warning[];
}
export interface MapResponse {
  catalog_version: string; items: Place[]; evidence: Evidence[];
  next_cursor: string | null;
}
export interface ReferenceData {
  interest_options: { id: string; label: string }[];
  categories: { id: Category; label: string }[];
  supported_city_ids: ['nizhny_novgorod'];
  supported_child_age: { min: 3; max: 11 };
  capabilities: {
    taxi_suggestions: boolean; weather_automation: boolean; free_text: boolean;
  };
  default_family_policy: FamilyPolicy;
}
export interface PublicRecommendationRequest {
  expected_version: number;
  purpose: 'initial' | 'restaurant' | 'along_route';
  date: ISODate | null; request_text: string | null;
  exclude_activity_ids: ID[]; limit: number;
}
export interface PublicRecommendationResponse {
  trip_id: ID; trip_version: number; catalog_version: string;
  candidates: Candidate[]; evidence: Evidence[]; warnings: Warning[];
  status: RecommendationResponse['status'];
}
export interface CatalogResponse {
  catalog_version: string; items: CatalogItem[]; evidence: Evidence[];
}
export interface TaxiSuggestion {
  trip_id: ID; trip_version: number; date: ISODate; leg_id: ID;
  walk_duration_sec: number; car_duration_sec: number;
  pickup_wait_duration_sec: number | null;
  booking_supported: false; automatically_applied: false;
  warnings: Warning[];
}
export interface ApiError {
  error: {
    code: string; message: string; request_id: ID; retryable: boolean;
    current_version: number | null;
    details: { path: string | null; code: string; message: string }[];
  };
}
