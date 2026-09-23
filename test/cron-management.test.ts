import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { registerWebConfigRoutes } from "../src/web/config-routes.js";
import { createWebRouteRegistry } from "../src/web/routes.js";
import type { WebAuth } from "../src/web/auth.js";
import type { AgentCore } from "../src/runtime/agent-core.js";
import type { FamiliarAgent } from "../src/agent/factory.js";
import { describe, it } from "node:test";
import { manageCron } from "../src/config/cron.js";
import { readCronJobs } from "../src/config/sections.js";
import { setConfigOverridesPath } from "../src/config/overrides.js";
import { applyConfigOverridesToConfig } from "../src/config/registry.js";
import { createCronTool } from "../src/tools/cron.js";
import type { CronJobConfig } from "../src/config/types.js";
import { dueCronSlot, loadSchedulerState, saveSchedulerState } from "../src/runtime/scheduler.js";
import { createSchedulerRunner, type SchedulerRunnerDeps } from "../src/runtime/scheduler-runner.js";
import { CRON_SKIPPED } from "../src/runtime/turn.js";
import { configWithDataDir, createTempDataDir, FakeResponse, jsonRequest } from "./helpers.js";

/** the request shape: create carries the name inside job; update names its target beside job */
const req = <T extends { name: string }>(action: "create" | "update", job: T) =>
  action === "create" ? { action, job } : { action, name: job.name, job };

const daily: CronJobConfig = { name: "daily", enabled: true, frequency: "daily", deliveryMode: "queue", prompt: "Check in", time: "09:00" };

describe("cron management", () => {
  it("shares tool CRUD, validation, concurrent writes and persisted overrides", async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    const tool = createCronTool(config);
    await tool.execute("create", req("create", daily));
    await Promise.all([
      manageCron(config, req("create", { ...daily, name: "second" })),
      manageCron(config, req("create", { ...daily, name: "third" })),
    ]);
    assert.deepEqual(config.cron.jobs.map((job) => job.name), ["daily", "second", "third"]);
    await assert.rejects(manageCron(config, req("create", daily)), /already exists/);
    await assert.rejects(manageCron(config, req("update", { ...daily, time: "25:00" })), /HH:MM/);
    await assert.rejects(manageCron(config, req("update", { ...daily, name: "missing" })), /not found/);
    await assert.rejects(manageCron(config, { action: "delete" }), /delete needs name/);
    await assert.rejects(manageCron(config, { action: "park", name: "daily" }), /action must be/);
    await manageCron(config, req("update", { ...daily, enabled: false, prompt: "Changed" }));
    await manageCron(config, { action: "delete", name: "second" });
    await manageCron(config, { action: "delete", name: "third" });
    const reloaded = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    applyConfigOverridesToConfig(reloaded);
    assert.deepEqual(reloaded.cron, config.cron);
    assert.deepEqual(reloaded.cron.jobs, [{ ...daily, enabled: false, prompt: "Changed" }]);
    const listed = await tool.execute("list", { action: "list" });
    assert.doesNotMatch(JSON.stringify(listed.content), /"timezone"/);
    assert.throws(() => readCronJobs([daily, daily], "cron", "camel"), /Duplicate/);
    assert.throws(() => readCronJobs([{ name: "once", prompt: "p", frequency: "once" }], "cron", "camel"), /runAt is required/);
    assert.throws(() => readCronJobs([{ ...daily, minute: 60 }], "cron", "camel"), /minute/);
    // Date.parse rolls impossible days over rather than rejecting them, so the day must be checked
    for (const runAt of ["2026-99-01 09:00", "2026-02-30 09:00", "2026-04-31 09:00", "2026-01-01 25:00", "tomorrow", "1"]) {
      assert.throws(() => readCronJobs([{ name: "once", prompt: "Remind me", frequency: "once", runAt }], "cron", "camel"), /runAt/);
    }
    assert.equal(readCronJobs([{ name: "once", prompt: "Remind me", frequency: "once", runAt: "2026-09-23T09:00:00+08:00" }], "cron", "camel").length, 1);
    await assert.rejects(manageCron(config, req("create", { name: "past", prompt: "Late", frequency: "once", runAt: "2020-01-01 09:00" })), /in the past/);
  });

  it("patches a stored job on update and resets the schedule when frequency changes", async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    const stored = async () => (await manageCron(config, { action: "list" })).jobs[0];
    await manageCron(config, req("create", daily));

    // name plus the one field that changes
    await manageCron(config, { action: "update", name: daily.name, job: { enabled: false } });
    assert.deepEqual(await stored(), { ...daily, enabled: false });
    await manageCron(config, req("update", { name: daily.name, prompt: "Changed" }));
    assert.deepEqual(await stored(), { ...daily, enabled: false, prompt: "Changed" });

    // same frequency keeps the schedule; changing it drops fields the new frequency cannot use
    await manageCron(config, req("update", { name: daily.name, time: "07:30" }));
    assert.equal((await stored()).time, "07:30");
    await manageCron(config, req("update", { name: daily.name, frequency: "hourly", minute: 15 }));
    assert.deepEqual(await stored(), { name: daily.name, enabled: false, prompt: "Changed", deliveryMode: "queue", frequency: "hourly", minute: 15 });

    // a create still has to be whole, and says which field is missing rather than blaming run_at
    await assert.rejects(manageCron(config, req("create", { name: "partial", prompt: "No frequency" })), /needs job\.name, job\.frequency, and job\.prompt/);
    await assert.rejects(manageCron(config, req("update", { name: "missing", enabled: false })), /not found/);

    // the name lives in job on create, beside it on update, and never changes: run history is keyed by it
    await assert.rejects(manageCron(config, { action: "create", name: "top", job: { ...daily, name: "top" } }), /inside job/);
    await assert.rejects(manageCron(config, req("create", daily)), /already exists: daily; use update/);
    await assert.rejects(manageCron(config, { action: "update", name: daily.name, job: { name: "renamed" } }), /can't rename/);
  });

  it("rejects schedule fields the frequency cannot use, naming them as the caller typed them", async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    // these used to be accepted and then ignored at fire time, so "wednesdays at 9" ran every day
    const cases: [Record<string, unknown>, string][] = [
      [{ frequency: "daily", time: "09:00", weekday: 3 }, "Config value job.weekday is only valid for weekly jobs"],
      [{ frequency: "daily", time: "09:00", minute: 42 }, "Config value job.minute is only valid for hourly jobs"],
      [{ frequency: "weekly", time: "09:00", day: 15 }, "Config value job.day is only valid for monthly jobs"],
      [{ frequency: "hourly", time: "09:00" }, "Config value job.time is only valid for daily, weekly, or monthly jobs"],
      [{ frequency: "daily", time: "09:00", runAt: "2099-01-01 09:00" }, "Config value job.runAt is only valid for once jobs"],
      [{ frequency: "once" }, "Config value job.runAt is required for once jobs"],
    ];
    for (const [fields, message] of cases) {
      // compared whole: the agent sent one camelCase job, so naming cron.jobs[0].run_at would point at a
      // field it never typed
      const thrown = await manageCron(config, req("create", { name: "j", prompt: "p", ...fields })).then(
        () => undefined,
        (error: Error) => error.message,
      );
      assert.equal(thrown, message);
    }
    assert.equal(config.cron.jobs.length, 0);
  });

  it("parks a once job whose run_at has already passed", async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    const future = { name: "once", prompt: "Remind me", frequency: "once", runAt: "2099-01-01 09:00" };
    await manageCron(config, req("create", future));
    // pretend it has since fired: its run_at is now in the past, but nothing new can be scheduled by
    // touching another field, so parking or renaming it must still work
    config.cron.jobs = [{ ...config.cron.jobs[0], runAt: "2020-01-01 09:00" }];
    await manageCron(config, req("update", { name: "once", enabled: false }));
    assert.equal(config.cron.jobs[0].enabled, false);
    // a parked job cannot fire, so moving its run_at into the past is harmless; waking it is not
    await manageCron(config, req("update", { name: "once", runAt: "2021-01-01 09:00" }));
    assert.equal(config.cron.jobs[0].runAt, "2021-01-01 09:00");
    await assert.rejects(manageCron(config, req("update", { name: "once", enabled: true, runAt: "2022-01-01 09:00" })), /in the past/);
  });

  it("drops the run record of a job that no longer exists", { timeout: 3000 }, async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir, { heartbeat: { enabled: false }, cron: { jobs: [], pollMs: 5 } });
    setConfigOverridesPath(dataDir);
    await manageCron(config, req("create", { ...daily, enabled: false }));
    await saveSchedulerState(dataDir, {
      cron: {
        daily: { lastFiredSlot: "daily:2026-09-21T09:00", lastFiredAt: "2026-09-21T13:04:11.000Z" },
        gone: { lastFiredSlot: "daily:2026-09-20T10:00", lastFiredAt: "2026-09-20T10:00:02.000Z" },
      },
    });
    // the list never shows a record whose job is gone, even before the scheduler's next tick
    assert.deepEqual(Object.keys((await manageCron(config, { action: "list" })).state), ["daily"]);

    const runner = createSchedulerRunner({
      config,
      familiarAgent: {},
      resolveDefaultSession: async () => ({ runtime: {} }),
      delivery: {},
      agentWork: { activeOwner: undefined },
    } as unknown as SchedulerRunnerDeps);
    t.after(() => runner.stop());
    await runner.start();
    // every job here is parked, so only the prune runs — it must not be gated behind having work
    for (let attempt = 0; attempt < 100; attempt++) {
      if (Object.keys((await loadSchedulerState(dataDir)).cron).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runner.stop();
    assert.deepEqual(Object.keys((await loadSchedulerState(dataDir)).cron), ["daily"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("refuses to hold more than twenty jobs", async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    for (let index = 1; index < 20; index++) await manageCron(config, req("create", { ...daily, name: `job-${index}` }));
    await manageCron(config, req("create", daily));
    assert.equal(config.cron.jobs.length, 20);
    await assert.rejects(manageCron(config, req("create", { ...daily, name: "overflow" })), /limit reached: 20/);
    // the cap blocks new jobs, never edits or removals of the ones already there
    await manageCron(config, req("update", { ...daily, prompt: "Still editable" }));
    await manageCron(config, { action: "delete", name: "job-1" });
    await manageCron(config, req("create", { ...daily, name: "overflow" }));
    assert.equal(config.cron.jobs.length, 20);
  });

  it("returns concise mutations", async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    const tool = createCronTool(config);
    const call = async (input: Parameters<typeof tool.execute>[1]) => {
      const result = await tool.execute("test", input);
      assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(result.details) }]);
      return result.details;
    };
    await manageCron(config, req("create", { ...daily, name: "unrelated" }));
    assert.deepEqual(await call(req("create", { name: daily.name, prompt: daily.prompt, frequency: daily.frequency, time: daily.time })), daily);
    const updated = { ...daily, prompt: "Updated reminder", enabled: false };
    assert.deepEqual(await call(req("update", updated)), updated);
    assert.deepEqual(await call(req("update", { ...updated, enabled: true })), { ...updated, enabled: true });
    assert.deepEqual(await call({ action: "delete", name: daily.name }), { deleted: daily.name });
  });

  it("exposes CRUD behind web authentication and returns validation errors", async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir);
    setConfigOverridesPath(dataDir);
    let authorized = false;
    const registry = createWebRouteRegistry(config, { authorize: async () => authorized } as unknown as WebAuth);
    registerWebConfigRoutes(registry.route, config, {} as AgentCore, {} as FamiliarAgent);
    const request = async (method: string, body: unknown = {}) => {
      const response = new FakeResponse();
      await registry.handleApi(jsonRequest(body, method), response as unknown as ServerResponse, new URL("http://localhost/api/web/cron"));
      return response;
    };
    assert.equal((await request("POST", req("create", daily))).statusCode, 401);
    assert.equal(config.cron.jobs.length, 0);
    authorized = true;
    assert.equal((await request("POST", req("create", daily))).statusCode, 200);
    assert.equal(JSON.parse((await request("GET")).body).jobs[0].name, daily.name);
    const invalid = await request("POST", req("create", { ...daily, name: "bad", time: "99:99" }));
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body, /HH:MM/);
    assert.equal((await request("POST", { action: "delete", name: daily.name })).statusCode, 200);
    assert.equal(JSON.parse((await request("GET")).body).jobs.length, 0);
  });

  it("deduplicates a once job but permits rescheduling it", () => {
    const job: CronJobConfig = { ...daily, frequency: "once", time: undefined, runAt: "2026-09-01 10:00" };
    const now = new Date(2026, 8, 3, 12);
    const lastFiredSlot = dueCronSlot(job, undefined, now);
    assert.equal(dueCronSlot(job, { lastFiredSlot }, now), undefined);
    assert.ok(dueCronSlot({ ...job, runAt: "2026-09-02 10:00" }, { lastFiredSlot }, now));
  });

  it("parks a once job as soon as it fires", { timeout: 3000 }, async (t) => {
    const dataDir = await createTempDataDir(t);
    const runAt = new Date(Date.now() - 60_000).toISOString();
    const once: CronJobConfig = { name: "once", enabled: true, frequency: "once", deliveryMode: "queue", prompt: "Now", runAt };
    const config = await configWithDataDir(t, dataDir, { heartbeat: { enabled: false }, cron: { jobs: [once], pollMs: 5 } });
    setConfigOverridesPath(dataDir);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const runner = createSchedulerRunner({
      config,
      familiarAgent: {},
      resolveDefaultSession: async () => ({ runtime: { noteRuntimeEvent: async () => {} } }),
      delivery: {},
      agentWork: {
        activeOwner: undefined,
        promptScheduledMessage: async (_runtime: unknown, buildMessage: () => Promise<unknown>) => {
          await buildMessage();
          finish();
          return CRON_SKIPPED;
        },
      },
    } as unknown as SchedulerRunnerDeps);
    t.after(() => runner.stop());
    await runner.start();
    await finished;
    runner.stop();
    assert.equal(config.cron.jobs[0]?.enabled, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("starts polling with no jobs and skips a job deleted while queued", { timeout: 3000 }, async (t) => {
    const dataDir = await createTempDataDir(t);
    const config = await configWithDataDir(t, dataDir, { heartbeat: { enabled: false }, cron: { jobs: [], pollMs: 5 } });
    setConfigOverridesPath(dataDir);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    let queuedResult: unknown;
    const deps = {
      config,
      familiarAgent: {},
      resolveDefaultSession: async () => ({ runtime: { appendError: async (message: string) => { throw new Error(message); } } }),
      delivery: {},
      agentWork: {
        activeOwner: undefined,
        promptScheduledMessage: async (_runtime: unknown, buildMessage: () => Promise<unknown>) => {
          await manageCron(config, { action: "delete", name: daily.name });
          queuedResult = await buildMessage();
          finish();
          return CRON_SKIPPED;
        },
      },
    } as unknown as SchedulerRunnerDeps;
    const runner = createSchedulerRunner(deps);
    t.after(() => runner.stop());
    await runner.start();
    await manageCron(config, req("create", daily));
    await finished;
    assert.equal(queuedResult, CRON_SKIPPED);
    runner.stop();
    // Let the final scheduler log finish before the test removes its workspace.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
