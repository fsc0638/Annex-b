//! agent-core: the cognitive pipeline (spec section 5).
//!
//! Phase 0 scope: crate compiles and exposes the pipeline stage enum as a
//! shared vocabulary. The actual perceive/retrieve/plan/act/reflect logic
//! (5.1-5.10) is Phase 2 work and is intentionally NOT implemented here yet.

/// The cognitive pipeline stages from spec section 5.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineStage {
    /// 5.1 perceive
    Perceive,
    /// 5.2 retrieve
    Retrieve,
    /// 5.3 should_react?
    ShouldReact,
    /// 5.4 react/converse
    React,
    /// 5.5 re-plan
    RePlan,
    /// 5.6 daily_plan
    DailyPlan,
    /// 5.7 reflect
    Reflect,
    /// 5.8 relationship update
    Relationship,
    /// 5.9 meeting (world rule)
    Meeting,
    /// 5.10 work_progress
    WorkProgress,
}

/// Memory retrieval scoring formula (spec 5.2), as a pure function so it is
/// independently unit-testable per spec 10.1.
///
/// `score(m) = w_recency * 0.995^(game_hours_diff) + w_importance *
/// (importance/10) + w_relevance * (cosine+1)/2`
pub fn retrieval_score(
    game_hours_diff: f64,
    importance: f64,
    cosine_similarity: f64,
    w_recency: f64,
    w_importance: f64,
    w_relevance: f64,
) -> f64 {
    let recency_term = w_recency * 0.995_f64.powf(game_hours_diff);
    let importance_term = w_importance * (importance / 10.0);
    let relevance_term = w_relevance * ((cosine_similarity + 1.0) / 2.0);
    recency_term + importance_term + relevance_term
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrieval_score_zero_hours_max_importance_max_cosine() {
        // At t=0, max importance (10), perfect cosine similarity (1.0),
        // default weights (1.0 each): recency=1.0, importance=1.0, relevance=1.0
        let score = retrieval_score(0.0, 10.0, 1.0, 1.0, 1.0, 1.0);
        assert!((score - 3.0).abs() < 1e-9);
    }

    #[test]
    fn retrieval_score_decays_with_time() {
        let fresh = retrieval_score(0.0, 5.0, 0.5, 1.0, 1.0, 1.0);
        let stale = retrieval_score(100.0, 5.0, 0.5, 1.0, 1.0, 1.0);
        assert!(fresh > stale);
    }

    #[test]
    fn retrieval_score_weights_zero_out_terms() {
        // Zeroing importance/relevance weights should leave only recency.
        let score = retrieval_score(0.0, 10.0, 1.0, 1.0, 0.0, 0.0);
        assert!((score - 1.0).abs() < 1e-9);
    }
}
