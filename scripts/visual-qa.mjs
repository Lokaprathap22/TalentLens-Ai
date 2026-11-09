import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import path from 'node:path';

const ARTIFACTS_DIR =
  'C:/Users/revat/.gemini/antigravity/brain/3ce88443-30ab-4208-babc-0e04d670a067';
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Realistic mock payloads
const mockRecruiterUser = {
  userId: 'usr-rec-1',
  organizationId: 'org-1',
  organizationName: 'Apex Executive Search',
  name: 'Elena Rostova',
  email: 'elena.rostova@talentlens.ai',
  role: 'RECRUITER',
};

const mockClientUser = {
  userId: 'usr-client-1',
  organizationId: 'org-client-1',
  organizationName: 'Cyberdyne Systems',
  name: 'Sarah Connor',
  email: 'sarah.connor@cyberdyne.io',
  role: 'CLIENT_HIRING_MANAGER',
};

const mockRecruiterDashboard = {
  role: 'RECRUITER',
  generatedAt: new Date().toISOString(),
  metrics: {
    totalActiveRequisitions: 8,
    requisitionsRequiringAttention: 2,
    candidatesInPipeline: 42,
    candidatesAwaitingAssessment: 3,
    candidatesAwaitingReview: 4,
    pendingClientDecisions: 4,
    upcomingConfirmedInterviews: 3,
  },
  pipelineStages: [
    { key: 'parsing', label: 'Parsing', count: 8, hint: 'Resumes being processed' },
    { key: 'review', label: 'Awaiting review', count: 4, hint: 'Need recruiter attention' },
    { key: 'shortlisted', label: 'Shortlisted', count: 7, hint: 'Reviewed by you' },
    { key: 'client', label: 'With client', count: 6, hint: 'Submitted, awaiting feedback' },
    { key: 'client-shortlisted', label: 'Client shortlist', count: 3, hint: 'Client interested' },
    { key: 'interview', label: 'Interviewing', count: 3, hint: 'Proposed or scheduled' },
  ],
  recentRequisitions: [
    {
      id: 'req-1',
      title: 'Staff Distributed Systems Engineer',
      clientName: 'Cyberdyne Systems',
      status: 'OPEN',
      candidatesCount: 16,
      awaitingReviewCount: 5,
      withClientCount: 3,
      updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    },
    {
      id: 'req-2',
      title: 'Principal Cloud Security Architect',
      clientName: 'Initech Corp',
      status: 'OPEN',
      candidatesCount: 12,
      awaitingReviewCount: 2,
      withClientCount: 2,
      updatedAt: new Date(Date.now() - 86400000 * 4).toISOString(),
    },
    {
      id: 'req-3',
      title: 'Lead Machine Learning Engineer',
      clientName: 'Soylent AI',
      status: 'OPEN',
      candidatesCount: 9,
      awaitingReviewCount: 4,
      withClientCount: 1,
      updatedAt: new Date(Date.now() - 86400000 * 6).toISOString(),
    },
    {
      id: 'req-4',
      title: 'VP of Platform Engineering',
      clientName: 'Cyberdyne Systems',
      status: 'PAUSED',
      candidatesCount: 5,
      awaitingReviewCount: 1,
      withClientCount: 0,
      updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
    },
  ],
  reviewQueue: [
    {
      candidateId: 'cand-1',
      requisitionId: 'req-1',
      candidateCode: 'CAN-8F2A1C',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      assessmentStatus: 'COMPLETE',
      score: 94,
      coverage: 91,
      consent: 'ACTIVE',
      lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      candidateId: 'cand-2',
      requisitionId: 'req-2',
      candidateCode: 'CAN-4E9B3D',
      requisitionTitle: 'Principal Cloud Security Architect',
      assessmentStatus: 'COMPLETE',
      score: 87,
      coverage: 83,
      consent: 'ACTIVE',
      lastActivityAt: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      candidateId: 'cand-3',
      requisitionId: 'req-1',
      candidateCode: 'CAN-3B1F8E',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      assessmentStatus: 'NEEDS_REVIEW',
      score: null,
      coverage: 38,
      consent: 'ACTIVE',
      lastActivityAt: new Date(Date.now() - 14400000).toISOString(),
    },
    {
      candidateId: 'cand-4',
      requisitionId: 'req-3',
      candidateCode: 'CAN-9C7D2A',
      requisitionTitle: 'Lead Machine Learning Engineer',
      assessmentStatus: 'NOT_ASSESSED',
      score: null,
      coverage: null,
      consent: 'PENDING',
      lastActivityAt: new Date(Date.now() - 86400000).toISOString(),
    },
  ],
  upcomingInterviews: [
    {
      id: 'int-1',
      candidateCode: 'CAN-8F2A1C',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      startAt: new Date(Date.now() + 86400000 * 1 + 3600000 * 4).toISOString(),
      endAt: new Date(Date.now() + 86400000 * 1 + 3600000 * 5).toISOString(),
      timezone: 'America/New_York',
      format: 'VIDEO',
      status: 'ACCEPTED',
    },
    {
      id: 'int-2',
      candidateCode: 'CAN-4E9B3D',
      requisitionTitle: 'Principal Cloud Security Architect',
      startAt: new Date(Date.now() + 86400000 * 2 + 3600000 * 2).toISOString(),
      endAt: new Date(Date.now() + 86400000 * 2 + 3600000 * 3).toISOString(),
      timezone: 'America/Chicago',
      format: 'VIDEO',
      status: 'PROPOSED',
    },
  ],
  recentActivity: [
    {
      id: 'act-1',
      kind: 'interview_proposed',
      summary: 'Interview confirmed for candidate CAN-8F2A1C with Cyberdyne Systems',
      actor: 'Elena Rostova',
      createdAt: new Date(Date.now() - 1800000).toISOString(),
    },
    {
      id: 'act-2',
      kind: 'review_recorded',
      summary: 'Recruiter Elena approved candidate CAN-4E9B3D for client shortlist',
      actor: 'Elena Rostova',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      id: 'act-3',
      kind: 'assessment_complete',
      summary: 'Assessment completed: 11 of 12 criteria verified from resume for CAN-8F2A1C',
      actor: 'System',
      createdAt: new Date(Date.now() - 14400000).toISOString(),
    },
  ],
};

const mockClientDashboard = {
  role: 'CLIENT_HIRING_MANAGER',
  generatedAt: new Date().toISOString(),
  metrics: {
    pendingCandidateReviews: 3,
    submittedAwaitingDecisions: 3,
    upcomingConfirmedInterviews: 2,
    recentDecisionsCount: 4,
    activeRequisitionsCount: 2,
  },
  pendingReviews: [
    {
      submissionId: 'sub-1',
      candidateCode: 'CAN-8F2A1C',
      requisitionId: 'req-1',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      clientId: 'client-1',
      clientName: 'Cyberdyne Systems',
      advisoryScore: 94,
      criteriaCount: 12,
      submittedAt: new Date(Date.now() - 7200000).toISOString(),
      status: 'SUBMITTED',
    },
    {
      submissionId: 'sub-2',
      candidateCode: 'CAN-4E9B3D',
      requisitionId: 'req-2',
      requisitionTitle: 'Principal Cloud Security Architect',
      clientId: 'client-1',
      clientName: 'Cyberdyne Systems',
      advisoryScore: 87,
      criteriaCount: 10,
      submittedAt: new Date(Date.now() - 28800000).toISOString(),
      status: 'SUBMITTED',
    },
  ],
  upcomingInterviews: [
    {
      id: 'int-1',
      candidateCode: 'CAN-8F2A1C',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      startAt: new Date(Date.now() + 86400000 * 1 + 3600000 * 4).toISOString(),
      endAt: new Date(Date.now() + 86400000 * 1 + 3600000 * 5).toISOString(),
      timezone: 'America/New_York',
      format: 'VIDEO',
      status: 'ACCEPTED',
    },
  ],
  recentDecisions: [
    {
      id: 'dec-1',
      decision: 'SHORTLIST',
      reason: 'Strong consensus on distributed consensus and Raft implementations',
      candidateCode: 'CAN-8F2A1C',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
    },
    {
      id: 'dec-2',
      decision: 'PROPOSE_INTERVIEW',
      reason: 'Schedule system design architecture round',
      candidateCode: 'CAN-4E9B3D',
      requisitionTitle: 'Principal Cloud Security Architect',
      createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    },
  ],
  activeRequisitions: [
    {
      id: 'req-1',
      title: 'Staff Distributed Systems Engineer',
      clientId: 'client-1',
      clientName: 'Cyberdyne Systems',
      status: 'OPEN',
      activeSubmissionsCount: 4,
      interviewsCount: 2,
    },
    {
      id: 'req-2',
      title: 'VP of Platform Engineering',
      clientId: 'client-1',
      clientName: 'Cyberdyne Systems',
      status: 'OPEN',
      activeSubmissionsCount: 2,
      interviewsCount: 1,
    },
  ],
  recentActivity: [
    {
      id: 'act-c-1',
      kind: 'interview_proposed',
      summary: 'Interview proposed for CAN-8F2A1C for tomorrow at 2:00 PM EST',
      actor: 'Sarah Connor',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ],
};

const mockRequisitionsList = [
  {
    id: 'req-1',
    clientId: 'client-1',
    clientName: 'Cyberdyne Systems',
    title: 'Staff Distributed Systems Engineer',
    jdText:
      'Job description for Staff Distributed Systems Engineer requiring Raft, Paxos, Go, and distributed consensus.',
    status: 'OPEN',
    createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: 'req-2',
    clientId: 'client-2',
    clientName: 'Initech Corp',
    title: 'Principal Cloud Security Architect',
    jdText:
      'Job description for Principal Cloud Security Architect requiring AWS, zero-trust, and threat modeling.',
    status: 'OPEN',
    createdAt: new Date(Date.now() - 86400000 * 15).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 4).toISOString(),
  },
  {
    id: 'req-3',
    clientId: 'client-3',
    clientName: 'Soylent AI',
    title: 'Lead Machine Learning Engineer',
    jdText:
      'Job description for Lead Machine Learning Engineer requiring PyTorch, CUDA, and distributed inference.',
    status: 'OPEN',
    createdAt: new Date(Date.now() - 86400000 * 20).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 6).toISOString(),
  },
  {
    id: 'req-4',
    clientId: 'client-1',
    clientName: 'Cyberdyne Systems',
    title: 'VP of Platform Engineering',
    jdText: 'Job description for VP of Platform Engineering.',
    status: 'DRAFT',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
  {
    id: 'req-5',
    clientId: 'client-4',
    clientName: 'Acme Cloud',
    title: 'Senior Site Reliability Engineer',
    jdText: 'Job description for Senior Site Reliability Engineer.',
    status: 'CLOSED',
    createdAt: new Date(Date.now() - 86400000 * 45).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 10).toISOString(),
  },
];

const mockGlobalCandidates = {
  items: [
    {
      candidateId: 'cand-1',
      candidateCode: 'CAN-8F2A1C',
      createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
      lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
      requisitionId: 'req-1',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      clientName: 'Cyberdyne Systems',
      resumeDocumentId: 'doc-1',
      resumeFileName: 'elena-rostova-resume.pdf',
      parseStatus: 'PARSED',
      currentRole: 'Senior Distributed Systems Architect',
      experienceYears: 9,
      location: 'New York, NY (Remote)',
      skills: ['Go', 'Raft', 'Kubernetes', 'gRPC'],
      assessmentId: 'ass-1',
      assessmentStatus: 'COMPLETED',
      overallScore: 94,
      coverage: 91,
      isComplete: true,
      criteriaCount: 12,
      criteriaMetCount: 11,
      reviewStatus: 'APPROVED_FOR_SHORTLIST',
      reviewedAt: new Date(Date.now() - 7200000).toISOString(),
      isShortlisted: true,
      shortlistedAt: new Date(Date.now() - 7200000).toISOString(),
      submissionStatus: 'SUBMITTED',
      submittedAt: new Date(Date.now() - 3600000).toISOString(),
      statusCategory: 'ASSESSED',
    },
    {
      candidateId: 'cand-2',
      candidateCode: 'CAN-4E9B3D',
      createdAt: new Date(Date.now() - 86400000 * 8).toISOString(),
      lastActivityAt: new Date(Date.now() - 7200000).toISOString(),
      requisitionId: 'req-2',
      requisitionTitle: 'Principal Cloud Security Architect',
      clientName: 'Initech Corp',
      resumeDocumentId: 'doc-2',
      resumeFileName: 'marcus-vance-cv.pdf',
      parseStatus: 'PARSED',
      currentRole: 'Lead Security Engineer',
      experienceYears: 11,
      location: 'San Francisco, CA',
      skills: ['AWS', 'Zero-Trust', 'Threat Modeling', 'Terraform'],
      assessmentId: 'ass-2',
      assessmentStatus: 'COMPLETED',
      overallScore: 87,
      coverage: 83,
      isComplete: true,
      criteriaCount: 10,
      criteriaMetCount: 9,
      reviewStatus: 'APPROVED_FOR_SHORTLIST',
      reviewedAt: new Date(Date.now() - 14400000).toISOString(),
      isShortlisted: true,
      shortlistedAt: new Date(Date.now() - 14400000).toISOString(),
      submissionStatus: 'INTERVIEW_PROPOSED',
      submittedAt: new Date(Date.now() - 10800000).toISOString(),
      statusCategory: 'ASSESSED',
    },
    {
      candidateId: 'cand-3',
      candidateCode: 'CAN-3B1F8E',
      createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      lastActivityAt: new Date(Date.now() - 14400000).toISOString(),
      requisitionId: 'req-1',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      clientName: 'Cyberdyne Systems',
      resumeDocumentId: 'doc-3',
      resumeFileName: 'candidate-3-profile.pdf',
      parseStatus: 'PARSED',
      currentRole: 'Backend Systems Engineer',
      experienceYears: 5,
      location: 'Austin, TX',
      skills: ['Go', 'PostgreSQL', 'Docker'],
      assessmentId: 'ass-3',
      assessmentStatus: 'COMPLETED',
      overallScore: null,
      coverage: 38,
      isComplete: true,
      criteriaCount: 12,
      criteriaMetCount: 4,
      reviewStatus: 'PENDING_REVIEW',
      reviewedAt: null,
      isShortlisted: false,
      shortlistedAt: null,
      submissionStatus: null,
      submittedAt: null,
      statusCategory: 'NEEDS_REVIEW',
    },
    {
      candidateId: 'cand-4',
      candidateCode: 'CAN-9C7D2A',
      createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
      lastActivityAt: new Date(Date.now() - 86400000).toISOString(),
      requisitionId: 'req-3',
      requisitionTitle: 'Lead Machine Learning Engineer',
      clientName: 'Soylent AI',
      resumeDocumentId: 'doc-4',
      resumeFileName: 'ml-lead-draft.pdf',
      parseStatus: 'PARSING',
      currentRole: 'ML Infrastructure Lead',
      experienceYears: 8,
      location: 'Seattle, WA',
      skills: ['PyTorch', 'Distributed Training', 'vLLM'],
      assessmentId: null,
      assessmentStatus: null,
      overallScore: null,
      coverage: null,
      isComplete: false,
      criteriaCount: 0,
      criteriaMetCount: 0,
      reviewStatus: 'PENDING_REVIEW',
      reviewedAt: null,
      isShortlisted: false,
      shortlistedAt: null,
      submissionStatus: null,
      submittedAt: null,
      statusCategory: 'AWAITING_ASSESSMENT',
    },
  ],
  total: 42,
  page: 1,
  pageSize: 10,
  totalPages: 5,
};

const mockClientsList = [
  {
    id: 'client-1',
    name: 'Cyberdyne Systems',
    status: 'ACTIVE',
    createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 5).toISOString(),
  },
  {
    id: 'client-2',
    name: 'Initech Corp',
    status: 'ACTIVE',
    createdAt: new Date(Date.now() - 86400000 * 90).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 12).toISOString(),
  },
  {
    id: 'client-3',
    name: 'Soylent AI Technologies',
    status: 'ACTIVE',
    createdAt: new Date(Date.now() - 86400000 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 8).toISOString(),
  },
  {
    id: 'client-4',
    name: 'Weyland-Yutani Dynamics',
    status: 'INACTIVE',
    createdAt: new Date(Date.now() - 86400000 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 20).toISOString(),
  },
];

const mockClientMembers = [
  {
    id: 'cm-1',
    membershipId: 'mem-1',
    userId: 'usr-client-1',
    clientId: 'client-1',
    organizationId: 'org-1',
    name: 'Sarah Connor',
    email: 'sarah.connor@cyberdyne.io',
    role: 'CLIENT_HIRING_MANAGER',
    membershipStatus: 'ACTIVE',
    userStatus: 'ACTIVE',
    createdAt: new Date(Date.now() - 86400000 * 45).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 10).toISOString(),
  },
  {
    id: 'cm-2',
    membershipId: 'mem-2',
    userId: 'usr-client-2',
    clientId: 'client-1',
    organizationId: 'org-1',
    name: 'Miles Dyson',
    email: 'miles.dyson@cyberdyne.io',
    role: 'CLIENT_HIRING_MANAGER',
    membershipStatus: 'ACTIVE',
    userStatus: 'INVITED',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
];

const mockInterviewsList = {
  items: [
    {
      id: 'int-1',
      submissionId: 'sub-1',
      requisitionId: 'req-1',
      requisitionTitle: 'Staff Distributed Systems Engineer',
      clientId: 'client-1',
      clientName: 'Cyberdyne Systems',
      candidateId: 'cand-1',
      candidateCode: 'CAN-8F2A1C',
      proposerUserId: 'usr-rec-1',
      proposerRole: 'RECRUITER',
      startAt: new Date(Date.now() + 86400000 * 1 + 3600000 * 4).toISOString(),
      endAt: new Date(Date.now() + 86400000 * 1 + 3600000 * 5).toISOString(),
      timezone: 'America/New_York',
      format: 'VIDEO',
      status: 'ACCEPTED',
      canAccept: false,
      canReject: false,
      canReschedule: true,
      canComplete: true,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
      interviewerNotes: 'Consensus algorithms and high-throughput streaming design.',
    },
    {
      id: 'int-2',
      submissionId: 'sub-2',
      requisitionId: 'req-2',
      requisitionTitle: 'Principal Cloud Security Architect',
      clientId: 'client-2',
      clientName: 'Initech Corp',
      candidateId: 'cand-2',
      candidateCode: 'CAN-4E9B3D',
      proposerUserId: 'usr-client-1',
      proposerRole: 'CLIENT_HIRING_MANAGER',
      startAt: new Date(Date.now() + 86400000 * 2 + 3600000 * 2).toISOString(),
      endAt: new Date(Date.now() + 86400000 * 2 + 3600000 * 3).toISOString(),
      timezone: 'America/Chicago',
      format: 'VIDEO',
      status: 'PROPOSED',
      canAccept: true,
      canReject: true,
      canReschedule: false,
      canComplete: false,
      createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
      interviewerNotes: 'Identity federation, zero-trust cloud boundaries, IAM audit.',
    },
    {
      id: 'int-3',
      submissionId: 'sub-3',
      requisitionId: 'req-3',
      requisitionTitle: 'Lead Machine Learning Engineer',
      clientId: 'client-3',
      clientName: 'Soylent AI',
      candidateId: 'cand-5',
      candidateCode: 'CAN-2D7C9A',
      proposerUserId: 'usr-rec-1',
      proposerRole: 'RECRUITER',
      startAt: new Date(Date.now() - 86400000 * 1).toISOString(),
      endAt: new Date(Date.now() - 86400000 * 1 + 3600000).toISOString(),
      timezone: 'America/Los_Angeles',
      format: 'VIDEO',
      status: 'COMPLETED',
      canAccept: false,
      canReject: false,
      canReschedule: false,
      canComplete: false,
      createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
      updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
      interviewerNotes:
        'Completed by Dr. Aris Thorne. Candidate demonstrated deep PyTorch kernel knowledge.',
    },
  ],
  counts: {
    total: 3,
    upcoming: 1,
    pendingAction: 1,
    completed: 1,
    rejected: 0,
  },
  total: 3,
  page: 1,
  pageSize: 10,
  totalPages: 1,
};

async function main() {
  console.log('Starting Vite server for Visual QA...');
  const server = await createServer({
    root: 'apps/web',
    server: { port: 5199, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await server.listen();
  const origin = 'http://127.0.0.1:5199';
  console.log(`Vite server running at ${origin}`);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const screenshots = [];

  async function capture(page, filename, width = 1440, height = 900) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(600);
    const filepath = path.join(ARTIFACTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`✓ Saved ${filename} (${width}x${height})`);
    screenshots.push(filename);
  }

  // 1. Recruiter Context
  const recruiterContext = await browser.newContext();
  const page = await recruiterContext.newPage();

  // Route API requests for Recruiter
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/me')) {
      return route.fulfill({ json: { user: mockRecruiterUser } });
    }
    if (url.includes('/auth/csrf')) {
      return route.fulfill({ json: { csrfToken: 'mock-csrf-token' } });
    }
    if (url.includes('/dashboard/summary')) {
      return route.fulfill({ json: mockRecruiterDashboard });
    }
    if (
      url.includes('/requisitions') &&
      !url.includes('/candidates') &&
      !url.includes('/scorecards')
    ) {
      return route.fulfill({ json: { requisitions: mockRequisitionsList } });
    }
    if (url.includes('/candidates')) {
      return route.fulfill({ json: mockGlobalCandidates });
    }
    if (url.includes('/clients/client-1/members')) {
      return route.fulfill({ json: { members: mockClientMembers } });
    }
    if (url.includes('/clients/client-1')) {
      return route.fulfill({ json: { client: mockClientsList[0] } });
    }
    if (url.includes('/clients')) {
      return route.fulfill({ json: { clients: mockClientsList } });
    }
    if (url.includes('/interviews')) {
      return route.fulfill({ json: mockInterviewsList });
    }
    return route.fulfill({ json: {} });
  });

  // SCREEN 1: Recruiter Dashboard
  console.log('Capturing Recruiter Dashboard...');
  await page.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
  await capture(page, 'qa-batch6-01-recruiter-dashboard-desktop.png', 1440, 900);
  await capture(page, 'qa-batch6-01-recruiter-dashboard-mobile.png', 390, 844);

  // SCREEN 2: Global Candidates Directory
  console.log('Capturing Global Candidates...');
  await page.goto(`${origin}/candidates`, { waitUntil: 'networkidle' });
  await capture(page, 'qa-batch6-02-global-candidates-desktop.png', 1440, 900);
  await capture(page, 'qa-batch6-02-global-candidates-mobile.png', 390, 844);

  // SCREEN 3: Requisitions Directory
  console.log('Capturing Requisitions...');
  await page.goto(`${origin}/requisitions`, { waitUntil: 'networkidle' });
  await capture(page, 'qa-batch6-03-requisitions-desktop.png', 1440, 900);

  // SCREEN 4: Interviews Workspace (Recruiter)
  console.log('Capturing Interviews Workspace...');
  await page.goto(`${origin}/interviews`, { waitUntil: 'networkidle' });
  await capture(page, 'qa-batch6-05-interviews-desktop.png', 1440, 900);
  await capture(page, 'qa-batch6-05-interviews-mobile.png', 390, 844);

  // SCREEN 5: Client Detail & Member Management
  console.log('Capturing Client Detail...');
  await page.goto(`${origin}/clients/client-1`, { waitUntil: 'networkidle' });
  await capture(page, 'qa-batch6-06-client-detail-desktop.png', 1440, 900);

  // SCREEN 6: Settings Page
  console.log('Capturing Settings...');
  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await capture(page, 'qa-batch6-10-settings-desktop.png', 1440, 900);

  // SCREEN 7: Login Page
  console.log('Capturing Login Page...');
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  await anonPage.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/me')) {
      return route.fulfill({ status: 401, json: { error: 'unauthenticated' } });
    }
    if (url.includes('/auth/csrf')) {
      return route.fulfill({ json: { csrfToken: 'mock-csrf-token' } });
    }
    return route.fulfill({ json: {} });
  });
  await anonPage.goto(`${origin}/login`, { waitUntil: 'networkidle' });
  await capture(anonPage, 'qa-batch6-09-login-desktop.png', 1440, 900);
  await capture(anonPage, 'qa-batch6-09-login-mobile.png', 390, 844);

  // SCREEN 8: Client Hiring Manager Portal & Dashboard
  console.log('Capturing Client Hiring Manager Experience...');
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/me')) {
      return route.fulfill({ json: { user: mockClientUser } });
    }
    if (url.includes('/auth/csrf')) {
      return route.fulfill({ json: { csrfToken: 'mock-csrf-token' } });
    }
    if (url.includes('/dashboard/summary')) {
      return route.fulfill({ json: mockClientDashboard });
    }
    if (url.includes('/submissions') || url.includes('/client-portal')) {
      return route.fulfill({
        json: {
          submissions: [
            {
              submissionId: 'sub-1',
              candidateRef: 'CAN-8F2A1C',
              requisitionId: 'req-1',
              requisitionTitle: 'Staff Distributed Systems Engineer',
              status: 'SUBMITTED',
              submittedAt: new Date(Date.now() - 7200000).toISOString(),
              assessmentSummary: {
                score: 94,
                coverage: 91,
                status: 'COMPLETED',
                criteriaCount: 12,
              },
              latestDecision: null,
            },
            {
              submissionId: 'sub-2',
              candidateRef: 'CAN-4E9B3D',
              requisitionId: 'req-2',
              requisitionTitle: 'Principal Cloud Security Architect',
              status: 'CLIENT_SHORTLISTED',
              submittedAt: new Date(Date.now() - 28800000).toISOString(),
              assessmentSummary: {
                score: 87,
                coverage: 83,
                status: 'COMPLETED',
                criteriaCount: 10,
              },
              latestDecision: {
                decision: 'SHORTLIST',
                createdAt: new Date(Date.now() - 86400000).toISOString(),
              },
            },
            {
              submissionId: 'sub-3',
              candidateRef: 'CAN-1A8D4E',
              requisitionId: 'req-1',
              requisitionTitle: 'Staff Distributed Systems Engineer',
              status: 'INTERVIEW_PROPOSED',
              submittedAt: new Date(Date.now() - 86400000).toISOString(),
              assessmentSummary: {
                score: 91,
                coverage: 88,
                status: 'COMPLETED',
                criteriaCount: 12,
              },
              latestDecision: null,
            },
          ],
        },
      });
    }
    if (url.includes('/clients')) {
      return route.fulfill({ json: { clients: [mockClientsList[0]] } });
    }
    if (url.includes('/interviews')) {
      return route.fulfill({ json: mockInterviewsList });
    }
    return route.fulfill({ json: {} });
  });

  await clientPage.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
  await capture(clientPage, 'qa-batch6-07-client-dashboard-desktop.png', 1440, 900);
  await capture(clientPage, 'qa-batch6-07-client-dashboard-mobile.png', 390, 844);

  await clientPage.goto(`${origin}/client-portal`, { waitUntil: 'networkidle' });
  await capture(clientPage, 'qa-batch6-08-client-portal-desktop.png', 1440, 900);
  await capture(clientPage, 'qa-batch6-08-client-portal-mobile.png', 390, 844);

  // SCREEN 9: Candidate Deletion & Consent Experience
  console.log('Capturing Candidate Deletion Journey...');
  const consentContext = await browser.newContext();
  const consentPage = await consentContext.newPage();
  await consentPage.route('**/api/v1/**', async (route) => {
    return route.fulfill({ json: {} });
  });
  await consentPage.goto(`${origin}/consent/deletion`, { waitUntil: 'networkidle' });
  await capture(consentPage, 'qa-batch7-01-consent-deletion-desktop.png', 1440, 900);
  await capture(consentPage, 'qa-batch7-01-consent-deletion-mobile.png', 390, 844);

  // SCREEN 10: Design System Showcase
  console.log('Capturing Design System Showcase...');
  await page.goto(`${origin}/design-system`, { waitUntil: 'networkidle' });
  await capture(page, 'qa-batch6-12-design-system-desktop.png', 1440, 900);

  console.log('Closing browser and server...');
  await browser.close();
  await server.close();
  console.log(
    `Visual QA completed! Generated ${screenshots.length} screenshots in ${ARTIFACTS_DIR}`,
  );
}

main().catch((err) => {
  console.error('Visual QA error:', err);
  process.exit(1);
});
