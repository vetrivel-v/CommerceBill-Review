import {
  ORDER_CHANNELS,
  ORDER_STATUSES,
  SalesOrderError,
  type SalesOrderContext,
  type SalesOrderService,
} from '@commercebill/sales-orders';
import {
  ErrorCodes,
  type SalesOrderDetail,
  type SalesOrderListResponse,
  type SalesOrderSaveResponse,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  channel: z.enum(ORDER_CHANNELS).optional(),
  search: z.string().trim().max(100).optional(),
  open: z.enum(['true', 'false']).optional(),
  dueOnOrBefore: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
/** Field-level validation belongs to the service; the route only checks the envelope. */
const looseBody = z.record(z.string(), z.unknown());
const BODY_LIMIT = 256 * 1024;

const bad = (message: string, problems?: { field: string; rule: string }[]) =>
  new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, message, problems);

/** Stable, value-free translation of service errors. Another organization's orders are simply "not found". */
function mapError(err: unknown): never {
  if (err instanceof SalesOrderError) {
    switch (err.code) {
      case 'not_found':
        throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
      case 'validation_failed':
        throw bad(err.message, err.problems);
      case 'duplicate_external_order':
      case 'operation_id_reused':
        throw new ApiHttpError(409, ErrorCodes.BUSINESS_RULE_VIOLATION, err.message, err.problems);
      case 'transition_not_allowed':
      case 'not_editable':
        throw new ApiHttpError(409, ErrorCodes.BUSINESS_RULE_VIOLATION, err.message, err.problems);
      case 'version_conflict':
        throw new ApiHttpError(
          409,
          ErrorCodes.DATABASE_CONFLICT,
          'This order was changed by someone else. Reload it and try again. Nothing was saved.',
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
const ctx = (req: FastifyRequest): SalesOrderContext => ({
  userId: req.auth!.userId,
  organizationId: req.auth!.organizationId,
  correlationId: req.id,
});

/**
 * Sales order routes (MTO-1, ADR-0031): launch secret (earlier hook), session authentication, exact keys (sales.order.read to look,
 * sales.order.write to create, change, confirm and cancel) and organization scope from the session. There is no DELETE: an order is
 * cancelled. Request bodies (buyer names, addresses, customization) are never logged.
 */
export async function registerSalesOrderRoutes(
  app: FastifyInstance,
  service: SalesOrderService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get(
      '/orders',
      { preHandler: requirePermission('sales.order.read') },
      async (req): Promise<SalesOrderListResponse> => {
        const q = listQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        return service.list(req.auth!.organizationId, {
          status: q.data.status,
          channel: q.data.channel,
          search: q.data.search,
          open: q.data.open === undefined ? undefined : q.data.open === 'true',
          dueOnOrBefore: q.data.dueOnOrBefore,
          limit: q.data.limit,
          offset: q.data.offset,
        });
      },
    );

    scope.get(
      '/orders/:id',
      { preHandler: requirePermission('sales.order.read') },
      async (req): Promise<SalesOrderDetail> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
        try {
          return await service.get(req.auth!.organizationId, p.data.id);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/orders',
      { preHandler: requirePermission('sales.order.write'), bodyLimit: BODY_LIMIT },
      async (req, reply): Promise<SalesOrderSaveResponse> => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid order.');
        try {
          const r = await service.create(ctx(req), body.data);
          return reply.code(r.replayed ? 200 : 201).send({ order: r.order, replayed: r.replayed });
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.put(
      '/orders/:id',
      { preHandler: requirePermission('sales.order.write'), bodyLimit: BODY_LIMIT },
      async (req): Promise<SalesOrderSaveResponse> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid order.');
        try {
          return { order: await service.update(ctx(req), p.data.id, body.data) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/orders/:id/status',
      { preHandler: requirePermission('sales.order.write'), bodyLimit: 8 * 1024 },
      async (req): Promise<SalesOrderSaveResponse> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid request.');
        try {
          return { order: await service.transition(ctx(req), p.data.id, body.data) };
        } catch (err) {
          return mapError(err);
        }
      },
    );
  });
}
