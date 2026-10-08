/*
 * Self-update helper. AIO Arr cannot replace its own container from the inside, so it starts this
 * script in a short-lived container made from the NEW image: wait a moment, recreate the AIO Arr
 * container (same settings, volumes and networks), reconnect containers that share its network, exit.
 *   node dist/updater.js <container id> <image reference> [base64 JSON: the old image's defaults]
 */
import { DockerClient, dockerTarget } from './services/docker.js';
import { dependentsOf, recreateContainer } from './domain/recreate.js';

async function main(): Promise<void> {
  const [id, ref, defaults] = process.argv.slice(2);
  if (!id || !ref) {
    console.error('usage: node dist/updater.js <container id> <image reference>');
    process.exit(2);
  }
  const target = dockerTarget();
  if (!target) throw new Error('Docker is not reachable from the helper container');
  const d = new DockerClient(target);
  // let AIO Arr finish answering the request that started us
  await new Promise((r) => setTimeout(r, 3000));
  const info = await d.inspect(id);
  const dependents = await dependentsOf(d, info.Id);
  let oldImageConfig: Record<string, unknown> | undefined;
  try {
    const parsed = defaults ? (JSON.parse(Buffer.from(defaults, 'base64').toString('utf8')) as Record<string, unknown>) : undefined;
    if (parsed && Object.keys(parsed).length) oldImageConfig = parsed;
  } catch {
    console.error('Ignoring unreadable image defaults');
  }
  const res = await recreateContainer(d, info, ref, { onStep: (m) => console.log(m), oldImageConfig });
  for (const dep of dependents) {
    try {
      const depInfo = await d.inspect(dep.Id);
      await recreateContainer(d, depInfo, String(depInfo.Config?.Image), { networkMode: `container:${res.id}` });
    } catch (err) {
      console.error(`Could not reconnect ${dep.Names?.[0] || dep.Id}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`AIO Arr updated${res.note ? ` (${res.note})` : ''}`);
}

main().catch((err) => {
  console.error('Self-update failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
