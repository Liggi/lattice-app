import React, { useState } from 'react';
import { Composer } from '../../components/Composer';

// The model menu opens upward, so each harness pins the composer to the bottom
// of the page as the app does; at the top the menu would open off-screen.
const models = [
  { id: 'opus', label: 'Opus', description: 'Most capable', isDefault: true },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
  { id: 'haiku', label: 'Haiku' },
];

export function InteractiveModelHarness() {
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<string>('none');
  const [submittedModel, setSubmittedModel] = useState<string>('none');

  return (
    <div className="dark bg-zinc-950 p-6" style={{ position: 'fixed', bottom: 0, left: 0, right: 0 }}>
      <Composer
        core={{
          onSubmit: (_message, options) => {
            setSubmittedModel(options?.model ?? 'undefined');
          },
        }}
        runtimeConfig={{
          isSessionConnected: true,
          sessionModel: 'claude-opus-4-20250101',
          availableModels: models,
          selectedModel,
          onModelChange: (id) => {
            setSelectedModel(id);
            setLastChange(id === null ? 'null' : id);
          },
        }}
      />
      <output data-testid="last-change">{lastChange}</output>
      <output data-testid="submitted-model">{submittedModel}</output>
    </div>
  );
}

const efforts = [
  { id: 'low', label: 'Low', description: 'Fast', isDefault: true },
  { id: 'high', label: 'High', description: 'Deeper reasoning' },
  { id: 'xhigh', label: 'XHigh', description: 'Maximum reasoning' },
];

export function EffortModelHarness() {
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<string>('none');
  const [lastEffortChange, setLastEffortChange] = useState<string>('none');
  const [submittedModel, setSubmittedModel] = useState<string>('none');
  const [submittedEffort, setSubmittedEffort] = useState<string>('none');

  return (
    <div className="dark bg-zinc-950 p-6" style={{ position: 'fixed', bottom: 0, left: 0, right: 0 }}>
      <Composer
        core={{
          onSubmit: (_message, options) => {
            setSubmittedModel(options?.model ?? 'undefined');
            setSubmittedEffort(options?.effort ?? 'undefined');
          },
        }}
        runtimeConfig={{
          isSessionConnected: true,
          sessionModel: 'claude-opus-4-20250101',
          availableModels: models,
          selectedModel,
          onModelChange: (id) => {
            setSelectedModel(id);
            setLastChange(id === null ? 'null' : id);
          },
          availableEfforts: efforts,
          selectedEffort,
          onEffortChange: (id) => {
            setSelectedEffort(id);
            setLastEffortChange(id === null ? 'null' : id);
          },
        }}
      />
      <output data-testid="last-change">{lastChange}</output>
      <output data-testid="last-effort-change">{lastEffortChange}</output>
      <output data-testid="submitted-model">{submittedModel}</output>
      <output data-testid="submitted-effort">{submittedEffort}</output>
    </div>
  );
}

export function ReadOnlyModelHarness() {
  return (
    <div className="dark bg-zinc-950 p-6" style={{ position: 'fixed', bottom: 0, left: 0, right: 0 }}>
      <Composer
        core={{ onSubmit: () => {} }}
        runtimeConfig={{
          isSessionConnected: true,
          sessionModel: 'claude-opus-4-20250101',
        }}
      />
    </div>
  );
}
