import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CriterionFormDialog } from './CriterionFormDialog.js';
import type { ScorecardCriterionRecord } from './types.js';

const mockCriterion: ScorecardCriterionRecord = {
  id: 'c0000000-0000-4000-8000-000000000001',
  key: 'k8s',
  label: 'Kubernetes Architecture',
  description: 'Production cluster management experience.',
  category: 'SKILL',
  requirementType: 'MUST_HAVE',
  weight: 25,
  displayOrder: 1,
  active: true,
  evidence: {
    sourceQuote: 'Hands-on Kubernetes experience',
    sourceStart: 50,
    sourceEnd: 80,
    verificationStatus: 'VERIFIED',
  },
};

const sampleJdText =
  'We are seeking a Lead Architect with hands-on Kubernetes experience and Go expertise.';

describe('CriterionFormDialog', () => {
  const onClose = vi.fn();
  const onSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when open is false', () => {
    const { container } = render(
      <CriterionFormDialog
        open={false}
        onClose={onClose}
        mode="create"
        onSubmit={onSubmit}
        jdText={sampleJdText}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders create mode with empty fields and default category/type', () => {
    render(
      <CriterionFormDialog
        open={true}
        onClose={onClose}
        mode="create"
        onSubmit={onSubmit}
        jdText={sampleJdText}
      />,
    );

    expect(screen.getByRole('heading', { name: /add screening criterion/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/criterion label/i)).toHaveValue('');
    expect(screen.getByLabelText(/source job description quote/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /add criterion/i })).toBeInTheDocument();
  });

  it('pre-populates existing criterion fields in edit mode', () => {
    render(
      <CriterionFormDialog
        open={true}
        onClose={onClose}
        mode="edit"
        initialCriterion={mockCriterion}
        onSubmit={onSubmit}
        jdText={sampleJdText}
      />,
    );

    expect(screen.getByRole('heading', { name: /edit criterion/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/criterion label/i)).toHaveValue('Kubernetes Architecture');
    expect(screen.getByLabelText(/source job description quote/i)).toHaveValue(
      'Hands-on Kubernetes experience',
    );
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('toggles job description inspection panel', async () => {
    const user = userEvent.setup();
    render(
      <CriterionFormDialog
        open={true}
        onClose={onClose}
        mode="create"
        onSubmit={onSubmit}
        jdText={sampleJdText}
      />,
    );

    expect(screen.getByText(/job description reference/i)).toBeInTheDocument();
    expect(screen.queryByText(sampleJdText)).not.toBeInTheDocument();

    const inspectBtn = screen.getByRole('button', { name: /inspect jd/i });
    await user.click(inspectBtn);

    expect(screen.getByText(sampleJdText)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide jd/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /hide jd/i }));
    expect(screen.queryByText(sampleJdText)).not.toBeInTheDocument();
  });

  it('submits form with trimmed label, description, and source quote', async () => {
    const user = userEvent.setup();
    render(
      <CriterionFormDialog
        open={true}
        onClose={onClose}
        mode="create"
        onSubmit={onSubmit}
        jdText={sampleJdText}
      />,
    );

    await user.type(screen.getByLabelText(/criterion label/i), '   Go Microservices   ');
    await user.clear(screen.getByLabelText(/weight percentage/i));
    await user.type(screen.getByLabelText(/weight percentage/i), '30');
    await user.type(screen.getByLabelText(/^description/i), 'Building scalable APIs.');
    await user.type(screen.getByLabelText(/source job description quote/i), '   Go expertise   ');

    await user.click(screen.getByRole('button', { name: /add criterion/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      label: 'Go Microservices',
      description: 'Building scalable APIs.',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 30,
      sourceQuote: 'Go expertise',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('validates required label and weight boundaries', async () => {
    const user = userEvent.setup();
    render(
      <CriterionFormDialog
        open={true}
        onClose={onClose}
        mode="create"
        onSubmit={onSubmit}
        jdText={sampleJdText}
      />,
    );

    // 1. Empty label validation
    await user.click(screen.getByRole('button', { name: /add criterion/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/please provide a name or title/i);

    // 2. Weight > 100 validation
    await user.type(screen.getByLabelText(/criterion label/i), 'Test Criterion');
    await user.clear(screen.getByLabelText(/weight percentage/i));
    await user.type(screen.getByLabelText(/weight percentage/i), '150');

    await user.click(screen.getByRole('button', { name: /add criterion/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /weight must be a positive percentage/i,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
