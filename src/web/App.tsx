import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Job, Plan, PlanItem, VolumeStatus } from '../shared/types';
import { count, formatAge, formatBytes } from './format';

type Stage = 'select' | 'drives' | 'plan' | 'run';

const STEPS: { stage: Stage; label: string }[] = [
  { stage: 'select', label: '1. Choose' },
  { stage: 'drives', label: '2. Drives' },
  { stage: 'plan', label: '3. Review' },
  { stage: 'run', label: '4. Back up' },
];

async function post<T>(path: string, body: object = {}): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BackerUpper': '1' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [stage, setStage] = useState<Stage>('select');
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const planRequested = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/state');
      setState((await response.json()) as AppState);
    } catch {
      setError('Lost contact with the backerUpper server.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!state) return;
    setSelected((current) => {
      if (current) return current;
      const defaults = state.apps.flatMap((app) => app.items).filter((item) => item.defaultSelected);
      return new Set(defaults.map((item) => item.key));
    });
    // Reopening the page during a backup goes straight back to its progress.
    if (state.job?.kind === 'run' && state.job.status === 'running') setStage('run');
  }, [state]);

  const items = useMemo(() => state?.apps.flatMap((app) => app.items) ?? [], [state]);
  const chosen = useMemo(() => items.filter((item) => selected?.has(item.key)), [items, selected]);
  const requiredVolumes = useMemo(() => {
    const ids = new Set(chosen.flatMap((item) => item.volumes));
    return state?.volumes.filter((volume) => ids.has(volume.id)) ?? [];
  }, [chosen, state]);
  const drivesReady = requiredVolumes.length > 0 && requiredVolumes.every((v) => v.mounted && v.readable);

  const createPlan = useCallback(async () => {
    setError(null);
    setStage('plan');
    try {
      await post<Job>('/api/plan', { keys: chosen.map((item) => item.key) });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [chosen, refresh]);

  // The review step starts by itself as soon as the last required drive appears.
  useEffect(() => {
    if (stage === 'drives' && drivesReady && !planRequested.current) {
      planRequested.current = true;
      void createPlan();
    }
    if (stage !== 'drives') planRequested.current = false;
  }, [stage, drivesReady, createPlan]);

  if (!state || !selected) return <main>Loading…</main>;

  const startOver = () => {
    setError(null);
    setStage('select');
  };

  return (
    <main>
      <header>
        <h1>backerUpper</h1>
        <ol className="steps">
          {STEPS.map((step) => (
            <li key={step.stage} className={step.stage === stage ? 'current' : ''}>
              {step.label}
            </li>
          ))}
        </ol>
      </header>
      {error && <div className="banner bad">{error}</div>}
      {stage === 'select' && (
        <SelectStage state={state} selected={selected} onChange={setSelected} onNext={() => setStage('drives')} />
      )}
      {stage === 'drives' && <DrivesStage volumes={requiredVolumes} onBack={startOver} />}
      {stage === 'plan' && (
        <PlanStage
          job={state.job}
          onBack={startOver}
          onReplan={createPlan}
          onCancel={() => void post('/api/cancel')}
          onStart={async (plan, acknowledgeGuard) => {
            setError(null);
            try {
              await post<Job>('/api/run', { planId: plan.id, acknowledgeGuard });
              await refresh();
              setStage('run');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
      {stage === 'run' && (
        <RunStage
          job={state.job}
          volumes={requiredVolumes}
          onCancel={() => void post('/api/cancel')}
          onDone={startOver}
          onError={setError}
        />
      )}
    </main>
  );
}

function SelectStage(props: {
  state: AppState;
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  onNext: () => void;
}) {
  const { state, selected, onChange, onNext } = props;
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (!next.delete(key)) next.add(key);
    onChange(next);
  };
  return (
    <>
      {state.apps.map((app) => (
        <section className="card" key={app.id}>
          <h2>{app.name}</h2>
          {app.items.map((item) => (
            <div className="row" key={item.key}>
              <label className="check row-main">
                <input type="checkbox" checked={selected.has(item.key)} onChange={() => toggle(item.key)} />
                <span>
                  {item.label}
                  {item.note && <span className="muted"> · {item.note}</span>}
                </span>
              </label>
              <span className="muted">{formatAge(item.lastBackupAt)}</span>
            </div>
          ))}
        </section>
      ))}
      <div className="actions">
        <button className="primary" disabled={selected.size === 0} onClick={onNext}>
          Continue
        </button>
      </div>
    </>
  );
}

function driveState(volume: VolumeStatus): { text: string; className: string } {
  if (!volume.mounted) return { text: 'Not mounted', className: 'pending' };
  if (!volume.readable) return { text: 'Access blocked', className: 'failed' };
  return { text: 'Ready', className: 'ok' };
}

function DrivesStage({ volumes, onBack }: { volumes: VolumeStatus[]; onBack: () => void }) {
  const blocked = volumes.some((volume) => volume.mounted && !volume.readable);
  return (
    <section className="card">
      <h2>Mount these drives</h2>
      <p className="muted">This step moves on by itself once every drive is ready.</p>
      {blocked && (
        <div className="banner bad">
          macOS is blocking access to a drive. Allow it for the app running backerUpper in System Settings &gt;
          Privacy &amp; Security &gt; Files &amp; Folders, then restart backerUpper.
        </div>
      )}
      {volumes.map((volume) => {
        const status = driveState(volume);
        return (
          <div className="row" key={volume.id}>
            <div className="row-main">
              {volume.label}
              {volume.freeBytes !== undefined && (
                <div className="muted">{formatBytes(volume.freeBytes)} free</div>
              )}
            </div>
            <span className={`state ${status.className}`}>{status.text}</span>
          </div>
        );
      })}
      <div className="actions" style={{ marginTop: 12 }}>
        <button onClick={onBack}>Back</button>
      </div>
    </section>
  );
}

function PlanRow({ item }: { item: PlanItem }) {
  const summary = item.mongo
    ? `Full dump: ${count(item.mongo.collections, 'collection')}, ${count(item.mongo.documents, 'document')}, to ${count(item.mongo.destinations.length, 'drive')}`
    : item.files
      ? `${count(item.files.newFiles, 'new file')}, ${count(item.files.changedFiles, 'changed file')}, ${count(item.files.deletedFiles, 'deleted file')}, ${formatBytes(item.files.bytesToCopy)} to copy`
      : '';
  const replaced = item.files?.replacedSamples ?? [];
  const fresh = item.files?.newSamples ?? [];
  return (
    <div className="row">
      <div className="row-main">
        {item.label}
        <div className="detail">{summary}</div>
        {item.files && !item.files.destinationExists && <div className="detail">First backup of this folder</div>}
        {item.blockers.map((text) => (
          <div className="state failed" key={text} style={{ whiteSpace: 'normal' }}>{text}</div>
        ))}
        {item.guardTriggered && <div className="state warning">Unusually large share of files replaced</div>}
        {replaced.length > 0 && (
          <details>
            <summary>Examples moved to {item.files?.replacedDir}</summary>
            <pre>{replaced.join('\n')}</pre>
          </details>
        )}
        {fresh.length > 0 && (
          <details>
            <summary>Examples of new files</summary>
            <pre>{fresh.join('\n')}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function PlanStage(props: {
  job: Job | null;
  onBack: () => void;
  onReplan: () => void;
  onCancel: () => void;
  onStart: (plan: Plan, acknowledgeGuard: boolean) => void;
}) {
  const { job, onBack, onReplan, onCancel, onStart } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  if (!job || job.kind !== 'plan' || job.status === 'running') {
    const finished = job?.items.filter((item) => item.state !== 'pending' && item.state !== 'running').length ?? 0;
    return (
      <section className="card">
        <h2>Checking what will change</h2>
        <p className="muted">Nothing is copied at this stage. {finished} of {job?.items.length ?? 0} checked.</p>
        <button onClick={onCancel}>Cancel</button>
      </section>
    );
  }
  const plan = job.plan;
  if (!plan) {
    return (
      <section className="card">
        <div className="banner bad">{job.error ?? 'The check did not finish.'}</div>
        <div className="actions">
          <button onClick={onBack}>Back</button>
          <button onClick={onReplan}>Try again</button>
        </div>
      </section>
    );
  }
  const blocked = plan.blockers.length > 0 || plan.items.some((item) => item.blockers.length > 0);
  return (
    <section className="card">
      <h2>Review the plan</h2>
      <p className="muted">
        Files that would be replaced or deleted are moved to a dated folder, not destroyed.
      </p>
      {plan.blockers.map((text) => (
        <div className="banner bad" key={text}>{text}</div>
      ))}
      {plan.items.map((item) => (
        <PlanRow item={item} key={item.key} />
      ))}
      {plan.guardTriggered && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <label className="check">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>I reviewed the replaced files above and want to continue.</span>
          </label>
        </div>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <button onClick={onBack}>Back</button>
        <button onClick={onReplan}>Check again</button>
        <button
          className="primary"
          disabled={blocked || (plan.guardTriggered && !acknowledged)}
          onClick={() => onStart(plan, acknowledged)}
        >
          Start backup
        </button>
      </div>
    </section>
  );
}

function RunStage(props: {
  job: Job | null;
  volumes: VolumeStatus[];
  onCancel: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const { job, volumes, onCancel, onDone, onError } = props;
  const [ejected, setEjected] = useState<Set<string>>(new Set());
  if (!job || job.kind !== 'run') return <section className="card">Starting…</section>;
  const running = job.status === 'running';
  const problems = job.items.filter((item) => item.state === 'failed' || item.state === 'warning').length;
  const eject = async (volume: VolumeStatus) => {
    try {
      await post('/api/eject', { volumeId: volume.id });
      setEjected((current) => new Set(current).add(volume.id));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <>
      <section className="card">
        <h2>{running ? 'Backing up' : job.status === 'cancelled' ? 'Backup cancelled' : problems ? 'Finished with problems' : 'Backup complete'}</h2>
        {job.error && <div className="banner bad">{job.error}</div>}
        {job.manifestWarnings?.map((text) => (
          <div className="banner warn" key={text}>{text}</div>
        ))}
        {job.items.map((item) => (
          <div className="row" key={item.key}>
            <div className="row-main">
              {item.label}
              {item.detail && <div className="detail">{item.detail}</div>}
              {item.percent !== undefined && (
                <>
                  <div className="bar"><div style={{ width: `${item.percent}%` }} /></div>
                  <div className="muted">{item.percent}% · {item.rate} · {item.eta} left</div>
                </>
              )}
            </div>
            <span className={`state ${item.state}`}>{item.state}</span>
          </div>
        ))}
        <div className="actions" style={{ marginTop: 12 }}>
          {running ? <button onClick={onCancel}>Cancel</button> : <button className="primary" onClick={onDone}>Done</button>}
        </div>
      </section>
      {!running && (
        <section className="card">
          <h2>Eject drives</h2>
          <p className="muted">Stop Tedography first if it is using a drive.</p>
          {volumes.map((volume) => (
            <div className="row" key={volume.id}>
              <span className="row-main">{volume.label}</span>
              {volume.mounted && !ejected.has(volume.id) ? (
                <button onClick={() => void eject(volume)}>Eject</button>
              ) : (
                <span className="muted">Ejected</span>
              )}
            </div>
          ))}
        </section>
      )}
      {job.log.length > 0 && (
        <details>
          <summary>Log</summary>
          <pre>{job.log.join('\n')}</pre>
        </details>
      )}
    </>
  );
}
