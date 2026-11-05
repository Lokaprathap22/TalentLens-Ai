import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  approveScorecardDraft,
  computeApprovalReadiness,
  getScorecard,
  resolveScorecardErrorMessage,
  updateScorecardDraft,
} from './scorecard.api.js';
import type {
  ApprovalReadinessCheck,
  CriterionCategory,
  CriterionInput,
  RequirementType,
  ScorecardCriterionRecord,
  ScorecardRecord,
} from './types.js';

export interface UseScorecardDetailState {
  scorecard: ScorecardRecord | null;
  loading: boolean;
  error: string | null;
  isSaving: boolean;
  isApproving: boolean;
  saveError: string | null;
  approvalError: string | null;
  dirty: boolean;
  isEditable: boolean;
  readiness: ApprovalReadinessCheck | null;
  reload: () => Promise<void>;
  updateCriterion: (
    criterionId: string,
    updates: Partial<Omit<ScorecardCriterionRecord, 'id' | 'key'>>,
  ) => void;
  addCriterion: (item: {
    label: string;
    description?: string | undefined;
    category: CriterionCategory;
    requirementType: RequirementType;
    weight: number;
    sourceQuote?: string | undefined;
  }) => void;
  toggleCriterionActive: (criterionId: string) => void;
  verifyCriterionEvidence: (criterionId: string) => void;
  saveDraft: () => Promise<ScorecardRecord | null>;
  approveDraft: () => Promise<ScorecardRecord | null>;
  resetChanges: () => void;
}

export function useScorecardDetail(
  requisitionId: string,
  scorecardVersionId: string,
): UseScorecardDetailState {
  const [scorecard, setScorecard] = useState<ScorecardRecord | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [isApproving, setIsApproving] = useState<boolean>(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const [dirty, setDirty] = useState<boolean>(false);
  const mountedRef = useRef(true);
  const baselineScorecardRef = useRef<ScorecardRecord | null>(null);
  const fetchVersionRef = useRef(0);

  const executeFetch = useCallback(
    async (version: number) => {
      if (!requisitionId.trim() || !scorecardVersionId.trim()) {
        if (mountedRef.current && fetchVersionRef.current === version) {
          setLoading(false);
        }
        return;
      }

      try {
        const record = await getScorecard(requisitionId, scorecardVersionId);
        if (!mountedRef.current || fetchVersionRef.current !== version) return;
        setScorecard(record);
        baselineScorecardRef.current = record;
        setDirty(false);
        setError(null);
      } catch (err) {
        if (!mountedRef.current || fetchVersionRef.current !== version) return;
        const message = resolveScorecardErrorMessage(err, 'Failed to load scorecard version.', {
          action: 'get',
        });
        setError(message);
      } finally {
        if (mountedRef.current && fetchVersionRef.current === version) {
          setLoading(false);
        }
      }
    },
    [requisitionId, scorecardVersionId],
  );

  useEffect(() => {
    mountedRef.current = true;
    const currentVersion = ++fetchVersionRef.current;
    void executeFetch(currentVersion);
    return () => {
      mountedRef.current = false;
    };
  }, [executeFetch]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaveError(null);
    setApprovalError(null);
    const nextVersion = ++fetchVersionRef.current;
    await executeFetch(nextVersion);
  }, [executeFetch]);

  const updateCriterion = useCallback(
    (criterionId: string, updates: Partial<Omit<ScorecardCriterionRecord, 'id' | 'key'>>) => {
      setScorecard((prev) => {
        if (!prev || prev.status !== 'DRAFT') return prev;
        const nextCriteria = prev.criteria.map((c) => {
          if (c.id === criterionId) {
            return { ...c, ...updates };
          }
          return c;
        });
        return { ...prev, criteria: nextCriteria };
      });
      setDirty(true);
    },
    [],
  );

  const addCriterion = useCallback(
    (item: {
      label: string;
      description?: string | undefined;
      category: CriterionCategory;
      requirementType: RequirementType;
      weight: number;
      sourceQuote?: string | undefined;
    }) => {
      setScorecard((prev) => {
        if (!prev || prev.status !== 'DRAFT') return prev;
        const newCriterion: ScorecardCriterionRecord = {
          id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          key: `manual-${prev.criteria.length + 1}`,
          label: item.label.trim(),
          description: item.description?.trim() ?? '',
          category: item.category,
          requirementType: item.requirementType,
          weight: Math.max(0, Math.min(100, item.weight)),
          displayOrder: prev.criteria.length + 1,
          active: true,
          evidence: item.sourceQuote?.trim()
            ? {
                sourceQuote: item.sourceQuote.trim(),
                sourceStart: null,
                sourceEnd: null,
                verificationStatus: 'PENDING_RECRUITER_REVIEW',
              }
            : null,
        };
        return {
          ...prev,
          criteria: [...prev.criteria, newCriterion],
        };
      });
      setDirty(true);
    },
    [],
  );

  const toggleCriterionActive = useCallback((criterionId: string) => {
    setScorecard((prev) => {
      if (!prev || prev.status !== 'DRAFT') return prev;
      const nextCriteria = prev.criteria.map((c) => {
        if (c.id === criterionId) {
          return { ...c, active: !c.active };
        }
        return c;
      });
      return { ...prev, criteria: nextCriteria };
    });
    setDirty(true);
  }, []);

  const verifyCriterionEvidence = useCallback((criterionId: string) => {
    setScorecard((prev) => {
      if (!prev || prev.status !== 'DRAFT') return prev;
      const nextCriteria = prev.criteria.map((c) => {
        if (c.id === criterionId && c.evidence) {
          return {
            ...c,
            evidence: {
              ...c.evidence,
              verificationStatus: 'VERIFIED' as const,
            },
          };
        }
        return c;
      });
      return { ...prev, criteria: nextCriteria };
    });
    setDirty(true);
  }, []);

  const resetChanges = useCallback(() => {
    if (baselineScorecardRef.current) {
      setScorecard(baselineScorecardRef.current);
      setDirty(false);
      setSaveError(null);
    }
  }, []);

  const saveDraft = useCallback(async (): Promise<ScorecardRecord | null> => {
    if (!scorecard || scorecard.status !== 'DRAFT') {
      return null;
    }

    setIsSaving(true);
    setSaveError(null);

    const payloadCriteria: CriterionInput[] = scorecard.criteria.map((criterion) => {
      const input: CriterionInput = {
        label: criterion.label,
        description: criterion.description,
        category: criterion.category,
        requirementType: criterion.requirementType,
        weight: criterion.weight,
        displayOrder: criterion.displayOrder,
        active: criterion.active,
      };
      // If it's an existing UUID criterion, pass the ID so the backend updates in place
      if (!criterion.id.startsWith('new-')) {
        input.id = criterion.id;
        input.key = criterion.key;
      }
      if (criterion.evidence) {
        input.evidence = criterion.evidence;
      }
      return input;
    });

    try {
      const updated = await updateScorecardDraft(requisitionId, scorecardVersionId, {
        criteria: payloadCriteria,
      });
      if (!mountedRef.current) return null;
      setScorecard(updated);
      baselineScorecardRef.current = updated;
      setDirty(false);
      return updated;
    } catch (err) {
      if (!mountedRef.current) return null;
      const message = resolveScorecardErrorMessage(err, 'Failed to save scorecard draft.', {
        action: 'update',
      });
      setSaveError(message);
      return null;
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [requisitionId, scorecard, scorecardVersionId]);

  const approveDraft = useCallback(async (): Promise<ScorecardRecord | null> => {
    if (!scorecard || scorecard.status !== 'DRAFT') {
      return null;
    }

    setIsApproving(true);
    setApprovalError(null);

    try {
      // If there are unsaved changes, save them first!
      if (dirty) {
        const saved = await saveDraft();
        if (!saved) {
          // saveDraft failed, abort approval
          return null;
        }
      }

      const approved = await approveScorecardDraft(requisitionId, scorecardVersionId);
      if (!mountedRef.current) return null;
      setScorecard(approved);
      baselineScorecardRef.current = approved;
      setDirty(false);
      return approved;
    } catch (err) {
      if (!mountedRef.current) return null;
      const message = resolveScorecardErrorMessage(err, 'Failed to approve scorecard draft.', {
        action: 'approve',
      });
      setApprovalError(message);
      return null;
    } finally {
      if (mountedRef.current) {
        setIsApproving(false);
      }
    }
  }, [dirty, requisitionId, saveDraft, scorecard, scorecardVersionId]);

  const readiness = useMemo(() => {
    return scorecard ? computeApprovalReadiness(scorecard) : null;
  }, [scorecard]);

  const isEditable = scorecard?.status === 'DRAFT';

  return {
    scorecard,
    loading,
    error,
    isSaving,
    isApproving,
    saveError,
    approvalError,
    dirty,
    isEditable,
    readiness,
    reload,
    updateCriterion,
    addCriterion,
    toggleCriterionActive,
    verifyCriterionEvidence,
    saveDraft,
    approveDraft,
    resetChanges,
  };
}
