import { z } from "zod";
import { env } from "~/env.server";
import { ZodWorker } from "~/platform/zodWorker.server";
import { EndpointRegisteredService } from "./endpoints/endpointRegistered.server";
import { apiAuthenticationRepository } from "./externalApis/apiAuthenticationRepository.server";
import { RegisterJobService } from "./jobs/registerJob.server";
import { ResumeTaskService } from "./runs/resumeTask.server";
import { StartRunService } from "./runs/startRun.server";
import { DeliverHttpSourceRequestService } from "./sources/deliverHttpSourceRequest.server";
import { StartQueuedRunsService } from "./runs/startQueuedRuns.server";
import { RunFinishedService } from "./runs/runFinished.server";
import {
  DynamicTriggerEndpointMetadataSchema,
  JobMetadataSchema,
  RegisterSchedulePayloadSchema,
  SourceMetadataSchema,
} from "@trigger.dev/internal";
import { RegisterSourceService } from "./sources/registerSource.server";
import { ActivateSourceService } from "./sources/activateSource.server";
import { DeliverEventService } from "./events/deliverEvent.server";
import { InvokeDispatcherService } from "./events/invokeDispatcher.server";
import { RegisterDynamicTriggerService } from "./triggers/registerDynamicTrigger.server";
import { RegisterScheduleService } from "./triggers/registerSchedule.server";

const workerCatalog = {
  organizationCreated: z.object({ id: z.string() }),
  endpointRegistered: z.object({ id: z.string() }),
  deliverEmail: z.object({
    email: z.string(),
    to: z.string(),
    name: z.string().optional(),
  }),
  githubAppInstallationDeleted: z.object({ id: z.string() }),
  githubPush: z.object({
    branch: z.string(),
    commitSha: z.string(),
    repository: z.string(),
  }),
  stopVM: z.object({ id: z.string() }),
  startInitialProjectDeployment: z.object({ id: z.string() }),
  startRun: z.object({ id: z.string() }),
  runFinished: z.object({ id: z.string() }),
  resumeTask: z.object({ id: z.string() }),
  deliverHttpSourceRequest: z.object({ id: z.string() }),
  refreshOAuthToken: z.object({
    organizationId: z.string(),
    connectionId: z.string(),
  }),
  registerJob: z.object({
    endpointId: z.string(),
    job: JobMetadataSchema,
  }),
  registerSource: z.object({
    endpointId: z.string(),
    source: SourceMetadataSchema,
  }),
  registerDynamicTrigger: z.object({
    endpointId: z.string(),
    dynamicTrigger: DynamicTriggerEndpointMetadataSchema,
  }),
  registerSchedule: z.object({
    endpointId: z.string(),
    schedule: RegisterSchedulePayloadSchema,
  }),
  activateSource: z.object({
    id: z.string(),
    orphanedEvents: z.array(z.string()).optional(),
  }),
  startQueuedRuns: z.object({ id: z.string() }),
  deliverEvent: z.object({ id: z.string() }),
  "events.invokeDispatcher": z.object({
    id: z.string(),
    eventRecordId: z.string(),
  }),
};

let workerQueue: ZodWorker<typeof workerCatalog>;

declare global {
  var __worker__: ZodWorker<typeof workerCatalog>;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (env.NODE_ENV === "production") {
  workerQueue = getWorkerQueue();
} else {
  if (!global.__worker__) {
    global.__worker__ = getWorkerQueue();
  }
  workerQueue = global.__worker__;
}

export async function init() {
  await workerQueue.initialize();
}

function getWorkerQueue() {
  return new ZodWorker({
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: 5,
      pollInterval: 1000,
      noHandleSignals: false,
    },
    schema: workerCatalog,
    tasks: {
      "events.invokeDispatcher": {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new InvokeDispatcherService();

          await service.call(payload.id, payload.eventRecordId);
        },
      },
      runFinished: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RunFinishedService();

          await service.call(payload.id);
        },
      },
      startQueuedRuns: {
        maxAttempts: 3,
        queueName: (payload) => `queue:${payload.id}`,
        handler: async (payload, job) => {
          const service = new StartQueuedRunsService();

          await service.call(payload.id);
        },
      },
      registerJob: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RegisterJobService();

          await service.call(payload.endpointId, payload.job);
        },
      },
      registerSource: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RegisterSourceService();

          await service.call(payload.endpointId, payload.source);
        },
      },
      registerDynamicTrigger: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RegisterDynamicTriggerService();

          await service.call(payload.endpointId, payload.dynamicTrigger);
        },
      },
      registerSchedule: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RegisterScheduleService();

          await service.call(payload.endpointId, payload.schedule);
        },
      },
      activateSource: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new ActivateSourceService();

          await service.call(payload.id, job.id, payload.orphanedEvents);
        },
      },
      deliverHttpSourceRequest: {
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new DeliverHttpSourceRequestService();

          await service.call(payload.id);
        },
      },
      startRun: {
        queueName: "executions",
        maxAttempts: 13,
        handler: async (payload, job) => {
          const service = new StartRunService();

          await service.call(payload.id);
        },
      },
      resumeTask: {
        queueName: "executions",
        maxAttempts: 13,
        handler: async (payload, job) => {
          const service = new ResumeTaskService();

          await service.call(payload.id);
        },
      },
      deliverEmail: {
        queueName: "internal-queue",
        priority: 100,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      startInitialProjectDeployment: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      stopVM: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      organizationCreated: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      githubPush: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      githubAppInstallationDeleted: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      endpointRegistered: {
        queueName: "internal-queue",
        handler: async (payload, job) => {
          const service = new EndpointRegisteredService();

          await service.call(payload.id);
        },
      },
      deliverEvent: {
        queueName: "event-dispatcher",
        handler: async (payload, job) => {
          const service = new DeliverEventService();

          await service.call(payload.id);
        },
      },
      refreshOAuthToken: {
        queueName: "internal-queue",
        handler: async (payload, job) => {
          await apiAuthenticationRepository.refreshConnection({
            connectionId: payload.connectionId,
          });
        },
      },
    },
  });
}

export { workerQueue };
