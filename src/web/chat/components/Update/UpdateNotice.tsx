import { useState } from 'react';
import { CircleArrowUp } from 'lucide-react';
import { useUpdateStatus } from '../../hooks/useUpdateStatus';
import { UpdateDialog } from './UpdateDialog';

/** The sidebar's last line when a newer Lattice is out; nothing otherwise. */
export function UpdateNotice(): JSX.Element | null {
  const status = useUpdateStatus();
  const [open, setOpen] = useState(false);
  if (!status?.latest) return null;
  return (
    <div className="shrink-0 border-t border-line px-3 pt-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)' }}>
      <button
        onClick={() => setOpen(true)}
        data-testid="sidebar-update-notice"
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-fg-2 transition-colors hover:bg-surface hover:text-fg cursor-pointer"
      >
        {/* The cards' 28px icon column, so it lines up with the rows above. */}
        <span className="flex w-7 shrink-0 justify-center"><CircleArrowUp size={16} className="text-accent" /></span>
        <span>
          {status.phase === 'installing' ? `Installing Lattice ${status.latest}` : `Lattice ${status.latest} is available`}
        </span>
      </button>
      {open && <UpdateDialog status={status} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Settings → General: which version this is and, when there is one, the newer one. */
export function UpdateSettingsSection(): JSX.Element | null {
  const status = useUpdateStatus();
  const [open, setOpen] = useState(false);
  if (!status) return null;
  const source = status.install.kind === 'source' && !status.preview;
  return (
    <div className="space-y-2" data-testid="settings-update">
      <p className="text-xs font-medium text-fg-2">Lattice version</p>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-sm text-fg">
          You have {status.current}.
          {status.latest && <span className="text-fg-2"> Lattice {status.latest} is available.</span>}
        </p>
        {status.latest && (
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent-soft text-accent text-[13px] font-medium hover:bg-accent/20 transition-colors cursor-pointer"
          >
            <CircleArrowUp size={14} />
            See what's new
          </button>
        )}
      </div>
      {!status.latest && (
        <p className="text-xs text-fg-3">
          {source
            ? 'Running from a source checkout, so it does not check for new versions. Update it with git.'
            : status.checkedAt
              ? 'This is the latest version. Lattice checks for a new one once a day.'
              : 'Lattice checks npm for a new version once a day.'}
        </p>
      )}
      {open && status.latest && <UpdateDialog status={status} onClose={() => setOpen(false)} />}
    </div>
  );
}
