package planner

import (
	"context"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

// CatalogSources preserves saved trips' catalog IDs when a new provider is enabled.
// Default is used only for new drafts; an existing trip selects its own provider.
type CatalogSources struct {
	Default  CandidateSource
	Versions map[string]CandidateSource
}

func (s CatalogSources) CatalogVersion() string {
	if s.Default == nil {
		return ""
	}
	return s.Default.CatalogVersion()
}
func (s CatalogSources) SourceForCatalog(version string) (CandidateSource, error) {
	if s.Default != nil && s.Default.CatalogVersion() == version {
		return s.Default, nil
	}
	if source, ok := s.Versions[version]; ok && source != nil && source.CatalogVersion() == version {
		return source, nil
	}
	return nil, ErrMLContract
}
func (s CatalogSources) Recommend(ctx context.Context, view c.TripView) (c.RecommendationResponse, error) {
	source, err := s.SourceForCatalog(view.CatalogVersion)
	if err != nil {
		return c.RecommendationResponse{}, err
	}
	return source.Recommend(ctx, view)
}

func (p Planner) ForCatalog(version string) (Planner, error) {
	if sources, ok := p.Source.(interface {
		SourceForCatalog(string) (CandidateSource, error)
	}); ok {
		source, err := sources.SourceForCatalog(version)
		if err != nil {
			return p, err
		}
		p.Source = source
	}
	return p, nil
}
