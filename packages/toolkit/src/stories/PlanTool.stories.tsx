import type { Meta, StoryObj } from '@storybook/react';
import { PlanTool } from '../components/tools/PlanTool';

const meta: Meta<typeof PlanTool> = {
  title: 'Tools/PlanTool',
  component: PlanTool,
};

export default meta;
type Story = StoryObj<typeof PlanTool>;

export const PendingApproval: Story = {
  args: {
    input: {
      plan: `## Migration Plan

### Phase 1: Schema Changes
- Add new \`sessions_v2\` table with updated schema
- Create migration script with rollback support
- Add indexes for common query patterns

### Phase 2: Data Migration
- Backfill existing sessions into new table
- Validate data integrity with checksums

### Phase 3: Cutover
- Update API routes to read from new table
- Monitor error rates for 24h
- Drop old table after confirmation

| Step | Risk | Mitigation |
|------|------|------------|
| Schema | Low | Additive only |
| Backfill | Medium | Chunked writes |
| Cutover | High | Feature flag |`,
    },
    result: '',
    isPendingApproval: true,
    onApprove: () => alert('Approved!'),
    onReject: () => alert('Rejected!'),
  },
};

export const ApprovedPlan: Story = {
  args: {
    input: { plan: '## Refactoring Plan\n\n1. Extract shared types\n2. Update imports\n3. Run tests' },
    result: '',
    isPendingApproval: false,
  },
};
