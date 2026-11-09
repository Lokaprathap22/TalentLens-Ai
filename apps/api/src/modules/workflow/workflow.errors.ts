export class WorkflowRequisitionAccessDeniedError extends Error {
  constructor(message = 'Access to requisition is denied or not assigned to recruiter') {
    super(message);
    this.name = 'WorkflowRequisitionAccessDeniedError';
  }
}

export class WorkflowRequisitionStatusError extends Error {
  constructor(status: string) {
    super(`Requisition is in status "${status}" and does not permit candidate workflow actions.`);
    this.name = 'WorkflowRequisitionStatusError';
  }
}

export class WorkflowCandidateNotFoundError extends Error {
  constructor(message = 'Candidate or resume record not found for this requisition') {
    super(message);
    this.name = 'WorkflowCandidateNotFoundError';
  }
}

export class WorkflowResumeNotInspectedError extends Error {
  constructor(
    message = 'Recruiter must inspect the original resume before shortlisting or submitting candidate to client.',
  ) {
    super(message);
    this.name = 'WorkflowResumeNotInspectedError';
  }
}

export class WorkflowConsentRequiredError extends Error {
  constructor(message = 'Active candidate consent for this exact requisition is required.') {
    super(message);
    this.name = 'WorkflowConsentRequiredError';
  }
}

export class WorkflowConsentMissingClientSharingError extends Error {
  constructor(
    message = 'Candidate consent notice does not authorize sharing profile and assessment data with the hiring client.',
  ) {
    super(message);
    this.name = 'WorkflowConsentMissingClientSharingError';
  }
}

export class WorkflowShortlistRequiredError extends Error {
  constructor(
    message = 'Candidate must be reviewed and shortlisted by a recruiter before submission to a client.',
  ) {
    super(message);
    this.name = 'WorkflowShortlistRequiredError';
  }
}

export class WorkflowDuplicateSubmissionError extends Error {
  constructor(
    message = 'An active submission for this candidate already exists on this requisition.',
  ) {
    super(message);
    this.name = 'WorkflowDuplicateSubmissionError';
  }
}

export class WorkflowSubmissionNotFoundError extends Error {
  constructor(message = 'Candidate submission not found') {
    super(message);
    this.name = 'WorkflowSubmissionNotFoundError';
  }
}

export class WorkflowSubmissionStateError extends Error {
  constructor(message = 'Invalid candidate submission state for this operation') {
    super(message);
    this.name = 'WorkflowSubmissionStateError';
  }
}

export class WorkflowClientUnauthorizedError extends Error {
  constructor(message = 'Client user is not authorized for this operation') {
    super(message);
    this.name = 'WorkflowClientUnauthorizedError';
  }
}

export class WorkflowClientNotFoundError extends Error {
  constructor(message = 'Client not found') {
    super(message);
    this.name = 'WorkflowClientNotFoundError';
  }
}

export class WorkflowClientConflictError extends Error {
  constructor(message = 'A client with this name already exists in the organization') {
    super(message);
    this.name = 'WorkflowClientConflictError';
  }
}

export class WorkflowClientMemberConflictError extends Error {
  readonly code: string;

  constructor(
    message = 'A member conflict occurred for this client',
    code = 'duplicate_membership',
  ) {
    super(message);
    this.name = 'WorkflowClientMemberConflictError';
    this.code = code;
  }
}

export class WorkflowInterviewNotFoundError extends Error {
  constructor(message = 'Interview proposal record not found') {
    super(message);
    this.name = 'WorkflowInterviewNotFoundError';
  }
}

export class WorkflowInterviewStateError extends Error {
  constructor(message = 'Invalid interview proposal state transition') {
    super(message);
    this.name = 'WorkflowInterviewStateError';
  }
}

export class WorkflowProhibitedFeedbackError extends Error {
  readonly category?: string | undefined;

  constructor(
    message = 'Client feedback contains prohibited non-job-related or protected-characteristic content.',
    category?: string,
  ) {
    super(message);
    this.name = 'WorkflowProhibitedFeedbackError';
    this.category = category;
  }
}
