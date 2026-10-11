import fs from 'node:fs';
import path from 'node:path';
import type { LatticePluginHost } from '@liggi/lattice-plugin-kit';

export default function activate(host: LatticePluginHost): void {
  const countFile = path.join(host.dataDir, 'count.json');
  const savedFile = path.join(host.dataDir, 'saved.json');
  const readJson = <T>(file: string, fallback: T): T => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as T : fallback);

  host.router.get('/count', (_req, res) => {
    res.json({ count: readJson(countFile, 0) });
  });
  host.router.post('/bump', (_req, res) => {
    const count = readJson(countFile, 0) + 1;
    fs.writeFileSync(countFile, JSON.stringify(count));
    res.json({ count });
  });
  host.router.post('/start', (req, res, next) => {
    const { message, workingDirectory } = (req.body ?? {}) as { message?: string; workingDirectory?: string };
    host.sessions.create({ message: message ?? 'Say hello.', workingDirectory })
      .then((session) => res.json(session))
      .catch(next);
  });
  host.router.get('/saved', (_req, res) => {
    res.json({ saved: readJson<string[]>(savedFile, []) });
  });

  host.command('note', ({ session, args, text }) => {
    if (!text.trim()) throw new Error('Pipe the note on standard input.');
    const { cardId } = host.confirm.ask(session, {
      question: `Save this note${args.title ? ` "${args.title}"` : ''}?`,
      detail: text,
      options: [
        { label: 'Save', consequence: 'The note is written to the plugin\'s data folder.' },
        { label: 'Don\'t save', consequence: 'Nothing is written.' },
      ],
      runs: 'Save',
    }, { name: 'save', payload: { text } });
    return `The note is on a card (${cardId}). End your turn; the user's answer arrives as a message.`;
  });

  host.confirm.handle('save', (payload) => {
    const { text } = payload as { text: string };
    fs.writeFileSync(savedFile, JSON.stringify([...readJson<string[]>(savedFile, []), text]));
    return 'The hello plugin saved the note.';
  });

  host.log.info('hello plugin ready');
}
