import { connect, NatsConnection } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NatsDriver } from '../../src/drivers/nats';
import { PubSubMessage } from '../../src/drivers/types';

// Runs against DBCLIENT_NATS_SERVERS (no auth). Uses unique subjects and a temporary
// JetStream stream that is deleted afterwards.
const env = process.env;
const run = Date.now().toString(36);
const until = async <T>(check: () => T | undefined, ms = 3000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(!env.DBCLIENT_NATS_SERVERS)('NatsDriver (integration)', () => {
  const driver = new NatsDriver({ id: 'it', name: 'it', type: 'nats', options: { servers: env.DBCLIENT_NATS_SERVERS, auth: 'none' } }, {});
  let helper: NatsConnection;
  const stream = `DBCLIENT_IT_${run.toUpperCase()}`;

  beforeAll(async () => {
    await driver.connect();
    helper = await connect({ servers: env.DBCLIENT_NATS_SERVERS });
    const jsm = await helper.jetstreamManager();
    await jsm.streams.add({ name: stream, subjects: [`it.${run}.js.>`] });
    await jsm.consumers.add(stream, { durable_name: 'worker', ack_policy: 'explicit' as never });
  });

  afterAll(async () => {
    const jsm = await helper.jetstreamManager();
    await jsm.streams.delete(stream).catch(() => undefined);
    await helper.close();
    await driver.disconnect();
  });

  it('subscribes with wildcards and receives payload and headers', async () => {
    const got: PubSubMessage[] = [];
    let changes = 0;
    driver.onDidChange(() => changes++);
    const sub = driver.subscribe(`it.${run}.*.>`, undefined, (m) => got.push(m));
    expect(driver.subscriptions()).toEqual([{ id: sub.id, subject: `it.${run}.*.>`, queue: undefined, received: 0 }]);
    expect(changes).toBe(1);

    await driver.publish(`it.${run}.orders.created`, '{"id":1}', { 'X-Trace': 'abc' });
    await driver.publish(`it.${run}.other`, 'not matched');
    const msg = await until(() => got[0]);
    expect(msg.subject).toBe(`it.${run}.orders.created`);
    expect(msg.data).toBe('{"id":1}');
    expect(msg.headers).toEqual({ 'X-Trace': ['abc'] });
    expect(msg.subscription).toBe(sub.id);
    expect(driver.subscriptions()[0].received).toBe(1);

    driver.unsubscribe(sub.id);
    expect(driver.subscriptions()).toEqual([]);
  });

  it('does request/reply', async () => {
    const responder = helper.subscribe(`it.${run}.echo`, {
      callback: (_err, m) => m.respond(new TextEncoder().encode(`pong:${new TextDecoder().decode(m.data)}`)),
    });
    await helper.flush();
    const reply = await driver.request(`it.${run}.echo`, 'ping', undefined, 2000);
    expect(reply.data).toBe('pong:ping');
    responder.unsubscribe();
    await expect(driver.request(`it.${run}.nobody`, 'x', undefined, 300)).rejects.toThrow();
  });

  it('shows subscriptions, JetStream streams and consumers in the tree', async () => {
    const sub = driver.subscribe(`it.${run}.tree`, 'workers', () => undefined);
    const root = await driver.children();
    expect(root.map((n) => n.label)).toEqual(['Subscriptions', 'JetStream', expect.stringMatching(/^Server/)]);

    const subs = await driver.children(root[0]);
    expect(subs.map((n) => `${n.label} ${n.description}`)).toEqual([`it.${run}.tree 0 msgs · queue workers`]);
    driver.unsubscribe(sub.id);

    await helper.jetstream().publish(`it.${run}.js.a`, new TextEncoder().encode('1'));
    const streams = await driver.children(root[1]);
    const ours = streams.find((s) => s.label === stream)!;
    expect(ours.description).toBe(`1 msgs · it.${run}.js.>`);
    const consumers = await driver.children(ours);
    expect(consumers.map((c) => c.label)).toEqual(['worker']);
    expect(consumers[0].description).toMatch(/1 pending/);
  });
});
