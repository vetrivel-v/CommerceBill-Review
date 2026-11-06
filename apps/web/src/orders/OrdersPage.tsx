import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CHANNEL_LABEL,
  ORDER_CHANNELS,
  ORDER_STATUSES,
  STATUS_LABEL,
} from '@commercebill/sales-orders/browser';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  PageHeader,
  SelectField,
  TextInput,
} from '@commercebill/ui';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { listOrders } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { formatInr } from '../products/money.js';
import { formatDate } from '../tax/model.js';
import { STATUS_TONE } from './model.js';

const PAGE_SIZE = 25;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Orders: a server-side searchable, filterable, paged list of manual sales orders. */
export function OrdersPage() {
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const canWrite = can('sales.order.write');

  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [paging, setPaging] = useState({ term, page: 0 });
  if (paging.term !== term) setPaging({ term, page: 0 });
  const page = paging.term === term ? paging.page : 0;
  const setPage = (next: number | ((p: number) => number)) =>
    setPaging({ term, page: typeof next === 'function' ? next(page) : next });

  const query = {
    ...(term ? { search: term } : {}),
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['orders', query],
    queryFn: () => authed((t) => listOrders(t, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = result.data;
  const filtered = Boolean(term) || status !== '' || channel !== '';
  const newButton = canWrite ? (
    <Button onClick={() => navigate('/orders/new')}>New order</Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Orders"
        description="Custom orders you have taken, from any source."
        actions={newButton}
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      <div className="mb-3 grid grid-cols-[1fr_11rem_9rem] items-end gap-3">
        <TextInput
          label="Search"
          type="search"
          placeholder="Order number, buyer or external order id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          autoComplete="off"
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All statuses</option>
          {ORDER_STATUSES.filter((s) => s !== 'IN_PRODUCTION' && s !== 'READY').map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Source"
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All sources</option>
          {ORDER_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </SelectField>
      </div>

      {result.isPending ? (
        <LoadingState label="Loading orders" />
      ) : result.isError ? (
        <div className="space-y-3">
          <Alert tone="error">{describeFailure(result.error)}</Alert>
          <Button variant="secondary" onClick={() => void result.refetch()}>
            Try again
          </Button>
        </div>
      ) : data!.total === 0 ? (
        filtered ? (
          <EmptyState
            title="No orders match"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                  setChannel('');
                  setPage(0);
                }}
              >
                Clear filters
              </Button>
            }
          >
            Try a different search or clear the filters.
          </EmptyState>
        ) : (
          <EmptyState title="No orders yet" action={newButton}>
            {canWrite
              ? 'Add your first order when a customer asks for something custom.'
              : 'Orders will appear here once they are added.'}
          </EmptyState>
        )
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Orders</caption>
              <thead className="bg-slate-50 text-xs text-slate-600 uppercase">
                <tr>
                  {['Order', 'Date', 'Source', 'Buyer', 'Due', 'Status'].map((h) => (
                    <th key={h} scope="col" className="px-2 py-2">
                      {h}
                    </th>
                  ))}
                  <th scope="col" className="px-2 py-2 text-right">
                    Agreed value
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.orders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-2 py-2 font-mono text-xs whitespace-nowrap">
                      {o.orderNumber}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">{formatDate(o.orderDate)}</td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {CHANNEL_LABEL[o.channel]}
                      {o.externalOrderId && (
                        <div className="font-mono text-xs text-slate-500">{o.externalOrderId}</div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <div className="max-w-xs font-medium break-words text-slate-900">
                        {o.buyerName}
                      </div>
                      {o.customerId && (
                        <div className="text-xs text-slate-500">Customer account</div>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {o.dueDate ? (
                        formatDate(o.dueDate)
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                      {formatInr(o.totalAmount)}
                      <div className="text-xs text-slate-500">
                        {o.lineCount} {o.lineCount === 1 ? 'item' : 'items'}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      <Link
                        to={`/orders/${o.id}`}
                        className="font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                        aria-label={`Open order ${o.orderNumber}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span>
              Showing {data!.offset + 1}-{data!.offset + data!.orders.length} of {data!.total}
            </span>
            <span className="flex gap-2">
              <Button
                variant="secondary"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={data!.offset + data!.orders.length >= data!.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}
    </>
  );
}
