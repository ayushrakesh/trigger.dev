import { PrismaClient } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { logger } from "../logger.server";
import { json } from "@remix-run/server-runtime";
import { RequestFilterSchema, requestFilterMatches } from "@trigger.dev/core";
import { EndpointApi } from "../endpointApi.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { createHttpSourceRequest } from "~/utils/createHttpSourceRequest";
import { ulid } from "../ulid.server";

export const HttpEndpointParamsSchema = z.object({
  httpEndpointId: z.string(),
  envType: z.string(),
  shortcode: z.string(),
});

type HttpEndpointParams = z.infer<typeof HttpEndpointParamsSchema>;

export class HandleHttpEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(params: HttpEndpointParams, request: Request) {
    const httpEndpoint = await this.#prismaClient.triggerHttpEndpoint.findUnique({
      where: {
        id: params.httpEndpointId,
      },
      include: {
        secretReference: true,
        project: {
          include: {
            environments: {
              where: {
                shortcode: params.shortcode,
              },
              include: {
                organization: true,
                project: true,
              },
            },
          },
        },
      },
    });

    if (!httpEndpoint) {
      logger.error("Could not find http endpoint", { httpEndpointId: params.httpEndpointId });
      return json(
        { error: true, message: "Could not find http endpoint" },
        {
          status: 404,
        }
      );
    }

    const environment = httpEndpoint.project.environments.at(0);
    if (!environment) {
      logger.error("Could not find environment", { shortcode: params.shortcode });
      return json({ error: true, message: "Could not find environment" }, { status: 404 });
    }

    const httpEndpointEnvironment =
      await this.#prismaClient.triggerHttpEndpointEnvironment.findUnique({
        where: {
          environmentId_httpEndpointId: {
            environmentId: environment.id,
            httpEndpointId: httpEndpoint.id,
          },
        },
        include: {
          endpoint: true,
        },
      });

    if (!httpEndpointEnvironment) {
      logger.error("Could not find http endpoint environment", {
        httpEndpointId: httpEndpoint.id,
        environmentId: environment.id,
      });
      return json(
        { error: true, message: "Could not find http endpoint environment" },
        { status: 404 }
      );
    }

    const immediateResponseFilter = RequestFilterSchema.safeParse(
      httpEndpointEnvironment.immediateResponseFilter
    );
    if (!immediateResponseFilter.success) {
      logger.error("Could not parse immediate response filter", {
        httpEndpointId: httpEndpoint.id,
        environmentId: environment.id,
        errors: immediateResponseFilter.error,
      });
      return json(
        { error: true, message: "Could not parse immediate response filter" },
        { status: 500 }
      );
    }

    //get the secret
    const secretStore = getSecretStore(httpEndpoint.secretReference.provider);
    const secretData = await secretStore.getSecret(
      z.object({ secret: z.string() }),
      httpEndpoint.secretReference.key
    );
    if (!secretData) {
      logger.error("Could not find secret", {
        httpEndpointId: httpEndpoint.id,
        environmentId: environment.id,
        secretReference: httpEndpoint.secretReference,
      });
      return json({ error: true, message: "Could not find secret" }, { status: 404 });
    }

    //if an immediate response is required, we fetch it from the user's endpoint
    const callClientImmediately = await requestFilterMatches(request, immediateResponseFilter.data);
    let httpResponse: Response | undefined;
    if (callClientImmediately) {
      const clonedRequest = request.clone();
      const client = new EndpointApi(environment.apiKey, httpEndpointEnvironment.endpoint.url);
      const { response, parser } = await client.deliverHttpEndpointRequestForResponse({
        key: httpEndpoint.key,
        secret: secretData.secret,
        request: await createHttpSourceRequest(clonedRequest),
      });

      const responseJson = await response.json();
      const parsedResponseResult = parser.safeParse(responseJson);
      if (!parsedResponseResult.success) {
        logger.error("Could not parse response from client", {
          httpEndpointId: httpEndpoint.id,
          environmentId: environment.id,
          responseJson,
          errors: parsedResponseResult.error,
        });
        return json(
          { error: true, message: "Could not parse response from client" },
          { status: 500 }
        );
      }

      const endpointResponse = parsedResponseResult.data;
      httpResponse = new Response(endpointResponse.body, {
        status: endpointResponse.status,
        headers: endpointResponse.headers,
      });
    }

    //if we don't want to trigger runs, return the response
    if (httpEndpointEnvironment.skipTriggeringRuns) {
      if (!httpResponse) {
        return json(
          { error: true, message: "Should only skip triggering runs, if there's a Response" },
          { status: 400 }
        );
      }
      return httpResponse;
    }

    //if the Endpoint responded and it wasn't a 200, then we don't want to trigger any runs
    if (httpResponse && httpResponse.status !== 200) {
      return httpResponse;
    }

    const ingestService = new IngestSendEvent();
    let rawBody: string | undefined;
    try {
      rawBody = await request.text();
    } catch (e) {}
    const url = requestUrl(request);
    const event = {
      headers: Object.fromEntries(request.headers) as Record<string, string>,
      url: url.href,
      method: request.method,
      rawBody,
    };

    const headerId =
      request.headers.get("idempotency-key") ?? request.headers.get("x-request-id") ?? ulid();

    //todo add payload type here, default would be JSON
    await ingestService.call(environment, {
      id: `${httpEndpoint.id}.${headerId}`,
      name: `httpendpoint.${httpEndpoint.key}`,
      source: httpEndpointEnvironment.source,
      payload: event,
    });

    return (
      httpResponse ??
      new Response(undefined, {
        status: 200,
      })
    );
  }
}
