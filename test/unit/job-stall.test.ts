import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { endedAt, HAND_REPORTED_REASON, isDealtWith, JobProgressStore, PROCESS_ENDED_REASON, ProgressError, type JobProgress, type JobStart } from '../../src/services/sessions/job-progress';
import { JobCounter, countFiles, runCountCommand } from '../../src/services/sessions/job-count';
import { JobWatch } from '../../src/services/sessions/job-watch';
import { ABANDONED_REASON, abandonedJobs, jobAbandonedLine, jobStallLine } from '../../src/services/sessions/job-stall-watch';
import type { WorkerState } from '../../src/types/worker-events';
import { cannotRead, FIRST_ITEM_MS, isStalled, jobRate, MIN_STALL_MS, stallAfterMs } from '../../src/types/job-stall';

const MIN = 60_000;

function job(over: Partial<JobProgress> = {}): JobProgress {
  return {
    session: 'conv-worker000', label: 'Biographies written', source: { kind: 'files', glob: '/tmp/x/*' },
    done: 802, total: 2548, startedAt: 0, startDone: 0, reportedAt: 0, movedAt: 0, samples: [{ at: 0, done: 0 }], ...over,
  };
}

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-stall-'));
}

function store(): JobProgressStore {
  return new JobProgressStore(path.join(dir(), 'jobs.json'));
}

const start = (over: Partial<JobStart> = {}): JobStart => ({ session: 'conv-a', label: 'Turns checked', source: { kind: 'files', glob: '/tmp/x/*' }, total: 10, ...over });

describe('when a running job counts as stuck', () => {
  it('gives a job 20 minutes for its first item, or twice what its agent said one takes', () => {
    expect(stallAfterMs(job({ done: 0 }))).toBe(FIRST_ITEM_MS);
    expect(stallAfterMs(job({ done: 0, each: 25 * MIN }))).toBe(50 * MIN);
    expect(isStalled(job({ done: 0 }), 20 * MIN + 1)).toBe(true);
  });

  it('allows twice the usual gap between moves for a job that moves in batches', () => {
    // Historical Figure, 10 Oct: a move about every 15 minutes.
    const batches = job({ movedAt: 45 * MIN, samples: [{ at: 0, done: 0 }, { at: 15 * MIN, done: 100 }, { at: 30 * MIN, done: 200 }, { at: 45 * MIN, done: 300 }] });
    expect(stallAfterMs(batches)).toBe(30 * MIN);
    expect(isStalled(batches, 45 * MIN + 31 * MIN)).toBe(true);
  });

  it('never calls a fast job stuck sooner than ten minutes', () => {
    expect(stallAfterMs(job({ samples: [{ at: 0, done: 0 }, { at: MIN, done: 5 }, { at: 2 * MIN, done: 9 }] }))).toBe(MIN_STALL_MS);
  });
});

describe('the rate, from measured moves only', () => {
  it('leaves out the setup before the first move', () => {
    // Motto worker, 10 Oct: 16 minutes of warm-up before the first of 96 calls, then about 5 a minute.
    expect(jobRate(job({ samples: [{ at: 0, done: 0 }, { at: 16 * MIN, done: 2 }, { at: 20 * MIN, done: 22 }] }))).toBe(5 / MIN);
  });

  it('has no rate until the job has moved twice', () => {
    expect(jobRate(job({ samples: [{ at: 0, done: 0 }, { at: 16 * MIN, done: 2 }] }))).toBe(0);
  });

  it('goes by the last half hour once the job has run longer', () => {
    const samples = [{ at: 0, done: 0 }, { at: MIN, done: 1 }, { at: 40 * MIN, done: 100 }, { at: 70 * MIN, done: 160 }];
    expect(jobRate(job({ samples }))).toBe(2 / MIN);
  });
});

describe('counting a job from its reads', () => {
  it('moves when the count changes and keeps a sample at each move', () => {
    const jobs = store();
    jobs.start(start(), 0, 0);
    jobs.observe('conv-a', 'Turns checked', { count: 0 }, undefined, MIN);
    const moved = jobs.observe('conv-a', 'Turns checked', { count: 3 }, undefined, 2 * MIN)!;
    expect(moved).toMatchObject({ done: 3, movedAt: 2 * MIN, reportedAt: 2 * MIN, samples: [{ at: 0, done: 0 }, { at: 2 * MIN, done: 3 }] });
  });

  it('finishes only when the count reaches the total, and stays as it finished', () => {
    // The re-finish bug, 10 Oct: a second --finished restarted 8 of 25 records, wiping their history.
    const jobs = store();
    jobs.start(start(), 2, 0);
    const finished = jobs.observe('conv-a', 'Turns checked', { count: 10 }, undefined, 5 * MIN)!;
    expect(finished).toMatchObject({ finishedAt: 5 * MIN, startedAt: 0, startDone: 2 });
    expect(jobs.observe('conv-a', 'Turns checked', { count: 10 }, undefined, 6 * MIN)).toBeNull();
    expect(() => jobs.stop('conv-a', 'Turns checked', 'done', 7 * MIN)).toThrow(ProgressError);
    expect(jobs.forSessions(['conv-a'], 8 * MIN)[0]).toEqual(finished);
  });

  it('stops short, saying where, when its process ends first', () => {
    // Contract events, 11 Oct: a spend stop ended the batch at 116 of 180 and it read Finished.
    const jobs = store();
    jobs.start(start({ total: 180, pid: 4242 }), 0, 0);
    const stopped = jobs.observe('conv-a', 'Turns checked', { count: 116 }, false, 9 * MIN)!;
    expect(stopped).toMatchObject({ done: 116, total: 180, stopped: PROCESS_ENDED_REASON });
    expect(stopped.finishedAt).toBeUndefined();
  });

  it('says the count cannot be read only after reads keep failing, and forgets once one works', () => {
    const jobs = store();
    jobs.start(start(), 0, 0);
    let latest = jobs.observe('conv-a', 'Turns checked', { error: 'a' }, undefined, MIN)!;
    expect(cannotRead(latest)).toBeNull();
    jobs.observe('conv-a', 'Turns checked', { error: 'b' }, undefined, 2 * MIN);
    latest = jobs.observe('conv-a', 'Turns checked', { error: '/x/out does not exist' }, undefined, 3 * MIN)!;
    expect(cannotRead(latest)).toBe('/x/out does not exist');
    expect(latest.readError?.since).toBe(MIN);
    expect(jobs.observe('conv-a', 'Turns checked', { count: 1 }, undefined, 4 * MIN)!.readError).toBeUndefined();
  });

  it('refuses a second job under a running one\'s label, and one with nothing left to count', () => {
    const jobs = store();
    jobs.start(start(), 0, 0);
    expect(() => jobs.start(start(), 0, MIN)).toThrow(/already running/);
    expect(() => jobs.start(start({ label: 'Other' }), 10, MIN)).toThrow(/nothing left to count/);
  });

  it('tells the stream when the panel would show something new, and not for a read that changed nothing', () => {
    const jobs = store();
    const seen: string[] = [];
    jobs.changes.on('changed', (change: { label: string }) => seen.push(change.label));
    jobs.start(start(), 0, 0);
    jobs.observe('conv-a', 'Turns checked', { count: 0 }, undefined, MIN);
    jobs.observe('conv-a', 'Turns checked', { count: 4 }, undefined, 2 * MIN);
    expect(seen).toEqual(['Turns checked', 'Turns checked']);
  });
});

describe('reading counts from the work', () => {
  it('counts the files in one folder matching the last part of the path', () => {
    const out = dir();
    for (const name of ['ec1.json', 'lc2.json', 'll3.json', 'notes.txt']) fs.writeFileSync(path.join(out, name), '');
    fs.mkdirSync(path.join(out, 'ec-folder'));
    expect(countFiles(path.join(out, '{ec,lc}*'))).toBe(2);
    expect(countFiles(path.join(out, '*.json'))).toBe(3);
    expect(() => countFiles(path.join(out, '*', 'x.json'))).toThrow(/Only the last part/);
    expect(() => countFiles(path.join(out, 'missing', '*'))).toThrow(/does not exist/);
  });

  it('counts lines by reading only what was added, and starts again when the file is replaced', async () => {
    const log = path.join(dir(), 'bank.log');
    fs.writeFileSync(log, 'batch repair a\nretry\nbatch repair b\nbatch rep');
    const counter = new JobCounter();
    const source = { kind: 'lines' as const, file: log, match: 'batch repair' };
    expect(await counter.count('k', source)).toBe(2);
    fs.appendFileSync(log, 'air c\n\nbatch repair d\n');
    expect(await counter.count('k', source)).toBe(4);
    fs.writeFileSync(log, 'batch repair z\n');
    expect(await counter.count('k', source)).toBe(1);
  });

  it('reads the number on the last line a command prints, and says why when it cannot', async () => {
    const cwd = dir();
    expect(await runCountCommand('echo starting; echo 1,204', cwd)).toBe(1204);
    await expect(runCountCommand('echo "year 879"', cwd)).rejects.toThrow('the command printed "year 879" as its last line, not a whole number');
    await expect(runCountCommand('echo no save open >&2; exit 3', cwd)).rejects.toThrow('the command exited with code 3: no save open');
  });
});

describe('starting and reading jobs on the server', () => {
  it('refuses a source it cannot read, starting nothing', async () => {
    const watch = new JobWatch({ store: store() });
    await expect(watch.start({ session: 'conv-a', label: 'Briefs', files: '/nowhere/out/*.json', total: 11 })).rejects.toThrow(
      "Can't read the count from files matching /nowhere/out/*.json: /nowhere/out does not exist. Nothing was started; fix the source and start it again.",
    );
    expect(watch.store.forSessions(['conv-a'])).toEqual([]);
  });

  it('measures the total from the input, and reads once more after the process has ended', async () => {
    const work = dir();
    fs.writeFileSync(path.join(work, 'input.jsonl'), '{}\n{}\n{}\n');
    let alive = true;
    const watch = new JobWatch({ store: store(), alive: () => alive });
    const { job: started } = await watch.start({ session: 'conv-a', label: 'Rows scored', files: path.join(work, '*.out'), totalLines: path.join(work, 'input.jsonl'), pid: 99 }, 0);
    expect(started).toMatchObject({ done: 0, total: 3, totalFrom: `lines in ${path.join(work, 'input.jsonl')}` });
    fs.writeFileSync(path.join(work, '1.out'), '');
    alive = false;
    fs.writeFileSync(path.join(work, '2.out'), '');
    await watch.readAll();
    expect(watch.store.forSessions(['conv-a'])[0]).toMatchObject({ done: 2, total: 3, stopped: PROCESS_ENDED_REASON });
  });
});

describe('the line the coordinator gets', () => {
  const owner = { kind: 'worker' as const, worker: 'conv-worker000', task: 'Rebuild Historical Figure for 1.20', stopped: false };
  it('names the job, the worker and how long it has been quiet', () => {
    const stuck = job({ movedAt: 14 * MIN, samples: [{ at: 0, done: 0 }, { at: 0, done: 700 }, { at: 14 * MIN, done: 802 }] });
    expect(jobStallLine(stuck, owner, 44 * MIN)).toBe(
      'A job in Running is stuck: "Biographies written" is at 802 of 2,548 and has not moved for 30 min (it usually moves every 14 min). '
      + 'It was started by conv-worker000 (Rebuild Historical Figure for 1.20). Its worker is still running.',
    );
  });
  it('says when a job has not finished its first item', () => {
    expect(jobStallLine(job({ done: 0, each: 10 * MIN }), { kind: 'coordinator' }, 25 * MIN)).toBe(
      'A job you started is stuck: "Biographies written" has not finished its first item 25 min after it started (its agent said one takes about 10 min).',
    );
  });
  it('gives the read error in full', () => {
    const unreadable = job({ readError: { message: 'the command took longer than 10 seconds and was stopped', since: 0, failures: 3 } });
    expect(jobStallLine(unreadable, { kind: 'coordinator' }, 5 * MIN)).toBe(
      'A job you started is stuck: "Biographies written" can\'t read its count: the command took longer than 10 seconds and was stopped.',
    );
  });
});

describe('a job its worker stopped working on', () => {
  function worker(over: Partial<WorkerState> = {}): WorkerState {
    return {
      worker: 'conv-worker000', provider: 'claude', model: null, task: 't', thread: null,
      startedAt: 0, phase: 'reported', question: null, since: 5 * MIN, waitingOn: null, ...over,
    };
  }

  it('is ended when the worker has stopped with no wait declared and no process of its running', () => {
    // CK3 mottos worker, 10 Oct: opened "heritages checked" at 1 of 59, reported its thread done and went idle.
    const open = job();
    expect(abandonedJobs([open], [worker()], () => true, () => false)).toEqual([{ job: open, state: worker() }]);
    expect(abandonedJobs([job({ pid: 7 })], [worker()], () => true, () => true)).toEqual([]);
  });

  it('is kept while the worker runs a turn, or declared a wait it has not worked past', () => {
    expect(abandonedJobs([job()], [worker()], () => false)).toEqual([]);
    expect(abandonedJobs([job()], [worker({ waitingOn: 'the re-ranking to finish' })], () => true)).toEqual([]);
    expect(abandonedJobs([job()], [worker({ waitingOn: 'the re-ranking to finish', workedSinceReport: true })], () => true)).toHaveLength(1);
  });

  it('never ends the coordinator\'s own job', () => {
    expect(abandonedJobs([job({ session: 'conv-front0000' })], [worker()], () => true)).toEqual([]);
  });

  it('leaves Running as stopped, and carries on where it was if started again', () => {
    const jobs = store();
    jobs.start(start(), 0, 0);
    jobs.observe('conv-a', 'Turns checked', { count: 4 }, undefined, 2 * MIN);
    expect(jobs.abandon('conv-a', 'Turns checked', ABANDONED_REASON, 3 * MIN)).toMatchObject({ stopped: ABANDONED_REASON, abandoned: true });
    expect(endedAt(jobs.forSessions(['conv-a'], 4 * MIN)[0])).toBe(3 * MIN);
    const resumed = jobs.start(start(), 6, 5 * MIN);
    expect(resumed).toMatchObject({ startedAt: 0, done: 6, samples: [{ at: 0, done: 0 }, { at: 2 * MIN, done: 4 }, { at: 5 * MIN, done: 6 }] });
    expect(resumed.stopped).toBeUndefined();
  });

  it('is dealt with once the worker\'s last report, written before it ended, has been', () => {
    const ended = job({ stopped: ABANDONED_REASON, abandoned: true, reportedAt: 10 * MIN });
    const reporter = { worker: true, reports: [{ seq: 7, at: 5 * MIN }] };
    expect(isDealtWith(ended, reporter, new Set([7]), 11 * MIN)).toBe(false);
    expect(isDealtWith(ended, reporter, new Set(), 11 * MIN)).toBe(true);
  });

  it('tells the coordinator in one line', () => {
    expect(jobAbandonedLine(job({ label: 'Heritages checked', done: 1, total: 59 }), 'conv-v6m8Fw9lW63i', 'Thin mottos')).toBe(
      '"Heritages checked" left Running at 1 of 59: conv-v6m8Fw9lW63i (Thin mottos) ended its turn without finishing it, '
      + 'with nothing running or armed, no wait declared and no process of the job\'s running, so the server marked it stopped. '
      + 'If the job should go on, send the worker something.',
    );
  });
});

describe('hand-reported jobs from before', () => {
  it('copies the file aside once, then ends the ones still open and keeps the rest', () => {
    const file = path.join(dir(), 'job-progress.json');
    const legacy = { session: 'conv-a', label: 'Gate conversations', done: 0, total: 2295, startedAt: 0, startDone: 0, reportedAt: 0, movedAt: 0 };
    const finished = { ...legacy, label: 'Briefs', done: 11, total: 11, finishedAt: 0 };
    fs.writeFileSync(file, JSON.stringify([legacy, finished]));
    const jobs = new JobProgressStore(file);
    expect(jobs.retireHandReported(MIN)).toBe(1);
    expect(JSON.parse(fs.readFileSync(file.replace('.json', '.hand-reported.json'), 'utf-8'))).toEqual([legacy, finished]);
    expect(jobs.forSessions(['conv-a'], MIN)).toEqual(expect.arrayContaining([{ ...legacy, reportedAt: MIN, stopped: HAND_REPORTED_REASON }, finished]));
    expect(jobs.retireHandReported(2 * MIN)).toBe(0);
  });
});
