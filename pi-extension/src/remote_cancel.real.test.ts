import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import contextLifecycleExtension from "@yourdigitaltoolbox/pi-context-lifecycle/extension";
import {
  CONTEXT_LIFECYCLE_REGISTRY_SYMBOL,
} from "@yourdigitaltoolbox/pi-context-lifecycle";
import {
  createDeferredFakeProvider,
  createDisposableHarnessRoots,
  withDisposableHarnessEnvironment,
} from "@yourdigitaltoolbox/pi-context-lifecycle/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import remotePiExtension, { _routeClientMessageFrom } from "./index.js";

function assistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never;
}

function waitFor<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

function eventName(event: AgentSessionEvent): string | undefined {
  return event.type === "agent_end" || event.type === "agent_settled" ? event.type : undefined;
}

describe("public SDK Remote cancellation", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, CONTEXT_LIFECYCLE_REGISTRY_SYMBOL);
  });

  test("aborts the exact active turn once and acknowledges only after genuine settlement", async () => {
    const roots = await createDisposableHarnessRoots();
    try {
      await withDisposableHarnessEnvironment(roots, async () => {
        const provider = createDeferredFakeProvider();
        const cancelledRun = provider.enqueue(assistantMessage("cancelled run"), { label: "agent-initial" });
        const nextRun = provider.enqueue(assistantMessage("next run succeeds"), { label: "agent-post-tool" });
        const authStorage = AuthStorage.inMemory();
        const modelRegistry = ModelRegistry.inMemory(authStorage);
        const settingsManager = SettingsManager.inMemory();
        const providerExtension = (pi: ExtensionAPI) => {
          pi.registerProvider(provider.provider, {
            api: provider.api,
            apiKey: "disposable-test-key",
            baseUrl: "http://localhost.invalid",
            models: provider.models.map((model) => ({
              id: model.id,
              name: model.name,
              api: model.api,
              reasoning: model.reasoning,
              input: model.input,
              cost: model.cost,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            })),
            streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
          });
        };
        const loader = new DefaultResourceLoader({
          cwd: roots.cwd,
          agentDir: roots.agentDir,
          settingsManager,
          extensionFactories: [providerExtension, contextLifecycleExtension, remotePiExtension],
        });
        await loader.reload();
        const { session } = await createAgentSession({
          cwd: roots.cwd,
          agentDir: roots.agentDir,
          authStorage,
          modelRegistry,
          settingsManager,
          resourceLoader: loader,
          sessionManager: SessionManager.create(roots.cwd, roots.sessions),
          model: provider.getModel(),
          tools: [],
        });
        await session.bindExtensions({ mode: "print" });

        const order: string[] = [];
        const cancelReplies: unknown[] = [];
        const initiatingSender = { send: vi.fn() };
        const cancellingSender = {
          send(message: unknown) {
            cancelReplies.push(message);
            if ((message as { type?: unknown }).type === "cancelled") order.push("cancelled");
          },
        };
        const unsubscribe = session.subscribe((event) => {
          const name = eventName(event);
          if (!name) return;
          if (name === "agent_end") {
            expect(cancelReplies).not.toContainEqual(expect.objectContaining({ type: "cancelled" }));
          }
          order.push(name);
        });

        try {
          _routeClientMessageFrom(initiatingSender as never, { type: "user_message", id: "real-turn-a", text: "start cancellable turn" }, {} as never);
          await waitFor(cancelledRun.call, "cancelled provider entry");
          _routeClientMessageFrom(cancellingSender as never, { type: "cancel", id: "real-cancel-a", target_id: "real-turn-a" }, {} as never);
          expect(cancelReplies).not.toContainEqual(expect.objectContaining({ type: "cancelled" }));

          const cancelledCompletion = await waitFor(cancelledRun.completed, "cancelled provider settlement");
          expect(cancelledCompletion.outcome).toBe("cancelled");
          await waitFor(session.waitForIdle(), "cancelled session idle");
          await vi.waitFor(() => expect(cancelReplies).toContainEqual({ type: "cancelled", in_reply_to: "real-cancel-a", target_id: "real-turn-a" }));
          expect(order).toEqual(["agent_end", "cancelled", "agent_settled"]);

          _routeClientMessageFrom(initiatingSender as never, { type: "user_message", id: "real-turn-b", text: "next normal turn" }, {} as never);
          await waitFor(nextRun.call, "next provider entry");
          nextRun.release();
          await waitFor(nextRun.completed, "next provider settlement");
          await waitFor(session.waitForIdle(), "next session idle");
          expect(provider.tracker).toMatchObject({ entered: 2, completed: 2, inFlight: 0, maxInFlight: 1 });
        } finally {
          unsubscribe();
          session.dispose();
        }
      });
    } finally {
      await roots.cleanup();
    }
  }, 15_000);
});
