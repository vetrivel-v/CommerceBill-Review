import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_LABEL,
  ORDER_CHANNELS,
  STATUS_LABEL,
  needsReason,
} from '@commercebill/sales-orders/browser';
import type {
  CustomerView,
  ProductView,
  SalesOrderDetail,
  SalesOrderStatus,
} from '@commercebill/shared-types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardGrid,
  Checkbox,
  LoadingState,
  PageHeader,
  SelectField,
  TextArea,
  TextInput,
} from '@commercebill/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  ApiError,
  changeOrderStatus,
  createOrder,
  getOrder,
  listCustomers,
  listProducts,
  updateOrder,
} from '../api.js';
import { useAuth } from '../auth.js';
import { STATE_OPTIONS } from '../customers/model.js';
import { SearchPicker } from '../invoices/SearchPicker.js';
import { describeFailure } from '../messages.js';
import { formatInr } from '../products/money.js';
import { formatDateTime } from '../tax/model.js';
import {
  STATUS_TONE,
  TRANSITION_HELP,
  TRANSITION_LABEL,
  emptyOrderForm,
  errorsFromProblems,
  formFromOrder,
  formTotal,
  lineAmount,
  newLineKey,
  toCreateBody,
  toUpdateBody,
  validateForm,
  type AddressForm,
  type FieldErrors,
  type OrderForm,
} from './model.js';

const smallInput =
  'h-9 w-full rounded-md border bg-white px-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600 disabled:bg-slate-100 disabled:text-slate-500';

function AddressFields({
  title,
  prefix,
  value,
  errors,
  disabled,
  onChange,
}: {
  title: string;
  prefix: 'billing' | 'shipping';
  value: AddressForm;
  errors: FieldErrors;
  disabled: boolean;
  onChange: (next: AddressForm) => void;
}) {
  const set = (patch: Partial<AddressForm>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">{title}</legend>
      <TextInput
        label={`${title}: address line 1`}
        value={value.line1}
        error={errors[`${prefix}.line1`]}
        disabled={disabled}
        maxLength={200}
        onChange={(e) => set({ line1: e.target.value })}
      />
      <TextInput
        label={`${title}: address line 2`}
        value={value.line2}
        error={errors[`${prefix}.line2`]}
        disabled={disabled}
        maxLength={200}
        onChange={(e) => set({ line2: e.target.value })}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextInput
          label={`${title}: city`}
          value={value.city}
          error={errors[`${prefix}.city`]}
          disabled={disabled}
          maxLength={100}
          onChange={(e) => set({ city: e.target.value })}
        />
        <TextInput
          label={`${title}: PIN code`}
          value={value.pinCode}
          error={errors[`${prefix}.pinCode`]}
          disabled={disabled}
          maxLength={6}
          inputMode="numeric"
          onChange={(e) => set({ pinCode: e.target.value })}
        />
      </div>
      <SelectField
        label={`${title}: state`}
        value={value.stateCode}
        error={errors[`${prefix}.stateCode`]}
        disabled={disabled}
        onChange={(e) => set({ stateCode: e.target.value })}
      >
        <option value="">Choose a state…</option>
        {STATE_OPTIONS.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name} ({s.code})
          </option>
        ))}
      </SelectField>
    </fieldset>
  );
}

/**
 * One order: a new order, or an existing one to view, edit while its status allows, move through the allowed statuses, and read its
 * history. Prices and totals shown while typing are a convenience; the server recomputes every amount. Customization is TEXT only.
 */
export function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const creating = id === undefined;
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const arrivedNotice = (location.state as { notice?: string } | null)?.notice;
  const queryClient = useQueryClient();
  const canWrite = can('sales.order.write');

  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => authed((t) => getOrder(t, id!)),
    enabled: !creating,
    retry: false,
    staleTime: 0,
  });

  const [form, setForm] = useState<OrderForm>(emptyOrderForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [sameBilling, setSameBilling] = useState(true);
  const [pending, setPending] = useState<SalesOrderStatus | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  // one id per screen: a retry after a lost answer is recognised by the server instead of creating a second order
  const operationId = useRef(crypto.randomUUID());

  const loaded: SalesOrderDetail | undefined = order.data;
  useEffect(() => {
    if (loaded) {
      const f = formFromOrder(loaded);
      setForm(f);
      const b = JSON.stringify(f.billing);
      setSameBilling(
        b === JSON.stringify(f.shipping) || b === JSON.stringify(emptyOrderForm().billing),
      );
    }
  }, [loaded]);

  const readOnly = !canWrite || (!creating && !loaded?.editable);
  const set = (patch: Partial<OrderForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setMessage(null);
  };

  function chooseCustomer(c: CustomerView) {
    setForm((f) => {
      const same = c.shippingSameAsBilling;
      const bill: AddressForm = {
        line1: c.billingAddressLine1,
        line2: c.billingAddressLine2 ?? '',
        city: c.billingCity ?? '',
        stateCode: c.billingStateCode,
        pinCode: c.billingPinCode ?? '',
      };
      return {
        ...f,
        customer: { id: c.id, code: c.code, name: c.displayName ?? c.legalName },
        buyerName: f.buyerName.trim() ? f.buyerName : (c.displayName ?? c.legalName),
        buyerPhone: f.buyerPhone.trim() ? f.buyerPhone : (c.phone ?? ''),
        buyerEmail: f.buyerEmail.trim() ? f.buyerEmail : (c.email ?? ''),
        billing: f.billing.line1.trim() ? f.billing : bill,
        shipping: f.shipping.line1.trim()
          ? f.shipping
          : same
            ? bill
            : {
                line1: c.shippingAddressLine1 ?? '',
                line2: c.shippingAddressLine2 ?? '',
                city: c.shippingCity ?? '',
                stateCode: c.shippingStateCode ?? '',
                pinCode: c.shippingPinCode ?? '',
              },
      };
    });
  }

  function addItem(p: ProductView) {
    setForm((f) => ({
      ...f,
      lines: [
        ...f.lines,
        {
          key: newLineKey(),
          productId: p.id,
          sku: p.sku,
          name: p.name,
          unitCode: p.unit?.code ?? '',
          decimals: p.unit?.decimalPlaces ?? 0,
          quantity: '1',
          // a starting point only: the agreed price is typed per order
          agreedUnitPrice: p.sellingPrice ?? '0.00',
          customization: '',
          externalLineId: '',
        },
      ],
    }));
    setMessage(null);
  }
  const editLine = (key: string, patch: Partial<OrderForm['lines'][number]>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
      queryClient.invalidateQueries({ queryKey: ['order', id] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] }),
    ]);
  };

  function fail(err: unknown) {
    if (err instanceof ApiError && err.status === 400 && err.problems.length > 0) {
      setErrors(errorsFromProblems(err.problems));
      setMessage({ tone: 'error', text: 'Some details need correcting. Nothing was saved.' });
    } else if (err instanceof ApiError && err.status === 409 && err.code === 'DB_0002') {
      setConflict(true);
      setMessage({
        tone: 'error',
        text: 'This order was changed by someone else. Reload it to see the latest version. Nothing was saved.',
      });
    } else if (err instanceof ApiError && err.status === 409) {
      if (err.problems.length > 0) setErrors(errorsFromProblems(err.problems));
      setMessage({
        tone: 'error',
        text:
          err.problems.length > 0
            ? 'Some details need correcting. Nothing was saved.'
            : 'That is not possible for this order any more. Reload it. Nothing was saved.',
      });
    } else {
      setMessage({ tone: 'error', text: `${describeFailure(err)} Nothing was saved.` });
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (readOnly || busy) return;
    const toSave: OrderForm = sameBilling ? { ...form, billing: { ...form.shipping } } : form;
    const early = validateForm(toSave, creating ? 'create' : 'update');
    if (Object.keys(early).length > 0) {
      setErrors(early);
      setMessage({ tone: 'error', text: 'Some details need correcting. Nothing was saved.' });
      return;
    }
    setErrors({});
    setBusy(true);
    setMessage(null);
    try {
      if (creating) {
        const r = await authed((t) => createOrder(t, toCreateBody(toSave, operationId.current)));
        await refresh();
        navigate(`/orders/${r.order.id}`, {
          state: { notice: `Order ${r.order.orderNumber} was saved as a draft.` },
        });
      } else {
        const r = await authed((t) => updateOrder(t, id!, toUpdateBody(toSave, loaded!.version)));
        await refresh();
        setConflict(false);
        setMessage({
          tone: 'success',
          text:
            r.order.version === loaded!.version
              ? 'No changes to save.'
              : `Saved. The order total is ${formatInr(r.order.totalAmount)}.`,
        });
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function transition() {
    if (!pending || !loaded || busy) return;
    if (needsReason(loaded.status, pending) && !note.trim()) {
      setNoteError('Please give a short reason.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await authed((t) =>
        changeOrderStatus(t, id!, {
          toStatus: pending,
          expectedVersion: loaded.version,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      );
      setPending(null);
      setNote('');
      setNoteError(null);
      await refresh();
      setMessage({
        tone: 'success',
        text: `The order is now ${STATUS_LABEL[pending].toLowerCase()}.`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.problems.length > 0) {
        const e = errorsFromProblems(err.problems);
        setNoteError(e.note ?? null);
        setErrors(e);
        setMessage({
          tone: 'error',
          text: Object.values(e).join(' ') || 'Some details need correcting.',
        });
      } else fail(err);
    } finally {
      setBusy(false);
    }
  }

  if (!creating && order.isPending) return <LoadingState label="Loading order" />;
  if (!creating && (order.isError || !loaded)) {
    const missing = order.error instanceof ApiError && order.error.status === 404;
    return (
      <>
        <PageHeader title="Order" />
        <div className="space-y-3">
          <Alert tone="error">
            {missing ? 'This order could not be found.' : describeFailure(order.error)}
          </Alert>
          <Link to="/orders" className="font-medium text-brand-700 hover:underline">
            Back to orders
          </Link>
        </div>
      </>
    );
  }

  const total = formTotal(form.lines);
  return (
    <>
      <PageHeader
        title={creating ? 'New order' : `Order ${loaded!.orderNumber}`}
        description={
          creating
            ? 'Take down what the customer asked for. It starts as a draft.'
            : `${CHANNEL_LABEL[loaded!.channel]}${loaded!.externalOrderId ? ` ${loaded!.externalOrderId}` : ''}`
        }
        actions={
          loaded ? (
            <Badge tone={STATUS_TONE[loaded.status]}>{STATUS_LABEL[loaded.status]}</Badge>
          ) : undefined
        }
      />
      {arrivedNotice && !message && <Alert tone="success">{arrivedNotice}</Alert>}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {conflict && (
        <div className="mt-2">
          <Button
            variant="secondary"
            onClick={() => {
              setConflict(false);
              setMessage(null);
              void order.refetch();
            }}
          >
            Reload the order
          </Button>
        </div>
      )}
      {!creating && !loaded!.editable && (
        <div className="mt-2">
          <Alert tone="info">
            This order is {STATUS_LABEL[loaded!.status].toLowerCase()} and can no longer be changed.
          </Alert>
        </div>
      )}
      {!creating && !canWrite && (
        <div className="mt-2">
          <Alert tone="info">You can view this order but not change it.</Alert>
        </div>
      )}

      {!creating && canWrite && loaded!.allowedTransitions.length > 0 && (
        <Card title="Order status">
          <div className="flex flex-wrap items-center gap-2">
            {loaded!.allowedTransitions.map((to) => (
              <Button
                key={to}
                variant={pending === to ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => {
                  setPending(pending === to ? null : to);
                  setNote('');
                  setNoteError(null);
                  setMessage(null);
                }}
              >
                {TRANSITION_LABEL[to] ?? STATUS_LABEL[to]}
              </Button>
            ))}
          </div>
          {pending && (
            <div className="mt-3 max-w-xl space-y-2">
              <p className="text-sm text-slate-600">{TRANSITION_HELP[pending]}</p>
              <TextArea
                label="Reason"
                requirement={needsReason(loaded!.status, pending) ? 'required' : 'optional'}
                value={note}
                error={noteError ?? undefined}
                maxLength={500}
                rows={2}
                onChange={(e) => {
                  setNote(e.target.value);
                  setNoteError(null);
                }}
              />
              <Button disabled={busy} onClick={() => void transition()}>
                {`Confirm: ${TRANSITION_LABEL[pending] ?? STATUS_LABEL[pending]}`}
              </Button>
            </div>
          )}
        </Card>
      )}

      <form
        onSubmit={(e) => void save(e)}
        noValidate
        className="mt-4 space-y-4"
        aria-label={creating ? 'New order form' : 'Order details'}
      >
        <CardGrid>
          <Card title="Order">
            <div className="space-y-3">
              {creating ? (
                <SelectField
                  label="Source"
                  requirement="required"
                  value={form.channel}
                  error={errors.channel}
                  onChange={(e) => set({ channel: e.target.value as OrderForm['channel'] })}
                >
                  {ORDER_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_LABEL[c]}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <p className="text-sm text-slate-600">
                  Source:{' '}
                  <span className="font-medium text-slate-900">
                    {CHANNEL_LABEL[loaded!.channel]}
                  </span>{' '}
                  <span className="text-xs text-slate-500">(cannot be changed)</span>
                </p>
              )}
              {creating && form.channel !== 'MANUAL' && (
                <TextInput
                  label="External order ID"
                  requirement="optional"
                  value={form.externalOrderId}
                  error={errors.externalOrderId}
                  maxLength={100}
                  hint="The order number on that channel. It must be unique for the channel."
                  onChange={(e) => set({ externalOrderId: e.target.value })}
                />
              )}
              <div className="grid grid-cols-2 gap-3">
                <TextInput
                  label="Order date"
                  type="date"
                  value={form.orderDate}
                  error={errors.orderDate}
                  disabled={readOnly}
                  onChange={(e) => set({ orderDate: e.target.value })}
                />
                <TextInput
                  label="Due date"
                  requirement="optional"
                  type="date"
                  value={form.dueDate}
                  error={errors.dueDate}
                  disabled={readOnly}
                  onChange={(e) => set({ dueDate: e.target.value })}
                />
              </div>
              <TextArea
                label="Notes"
                requirement="optional"
                value={form.notes}
                error={errors.notes}
                disabled={readOnly}
                maxLength={2000}
                rows={3}
                onChange={(e) => set({ notes: e.target.value })}
              />
            </div>
          </Card>

          <Card title="Buyer">
            <div className="space-y-3">
              {!readOnly && (
                <SearchPicker<CustomerView>
                  label="Link a customer (optional)"
                  placeholder="Search customers by name, code or phone"
                  queryKey="order-customers"
                  load={async (term) =>
                    (
                      await authed((t) =>
                        listCustomers(t, { search: term, isActive: true, limit: 8, offset: 0 }),
                      )
                    ).customers
                  }
                  itemKey={(c) => c.id}
                  renderItem={(c) => (
                    <span>
                      <span className="font-mono text-xs">{c.code}</span>{' '}
                      <span className="font-medium">{c.displayName ?? c.legalName}</span>
                    </span>
                  )}
                  onPick={chooseCustomer}
                  clearOnPick
                />
              )}
              {form.customer && (
                <p className="text-sm text-slate-700">
                  Linked customer:{' '}
                  <strong>
                    {form.customer.code} {form.customer.name}
                  </strong>{' '}
                  {!readOnly && (
                    <button
                      type="button"
                      className="text-xs font-medium text-brand-700 hover:underline"
                      onClick={() => set({ customer: null })}
                    >
                      Unlink
                    </button>
                  )}
                </p>
              )}
              <TextInput
                label="Buyer name"
                requirement="required"
                value={form.buyerName}
                error={errors['buyer.name']}
                disabled={readOnly}
                maxLength={200}
                onChange={(e) => set({ buyerName: e.target.value })}
              />
              <div className="grid grid-cols-2 gap-3">
                <TextInput
                  label="Buyer phone"
                  requirement="optional"
                  value={form.buyerPhone}
                  error={errors['buyer.phone']}
                  disabled={readOnly}
                  maxLength={30}
                  onChange={(e) => set({ buyerPhone: e.target.value })}
                />
                <TextInput
                  label="Buyer email"
                  requirement="optional"
                  value={form.buyerEmail}
                  error={errors['buyer.email']}
                  disabled={readOnly}
                  maxLength={254}
                  onChange={(e) => set({ buyerEmail: e.target.value })}
                />
              </div>
              <p className="text-xs text-slate-500">
                The buyer and addresses are copied onto the order. A marketplace buyer does not need
                a customer record.
              </p>
            </div>
          </Card>

          <Card title="Addresses">
            <div className="space-y-3">
              <AddressFields
                title="Delivery"
                prefix="shipping"
                value={form.shipping}
                errors={errors}
                disabled={readOnly}
                onChange={(shipping) => set({ shipping })}
              />
              <Checkbox
                label="Billing address is the same as the delivery address"
                checked={sameBilling}
                disabled={readOnly}
                onChange={(e) => setSameBilling(e.target.checked)}
              />
              {!sameBilling && (
                <AddressFields
                  title="Billing"
                  prefix="billing"
                  value={form.billing}
                  errors={errors}
                  disabled={readOnly}
                  onChange={(billing) => set({ billing })}
                />
              )}
            </div>
          </Card>
        </CardGrid>

        <Card title="Items">
          {!readOnly && (
            <div className="mb-3 max-w-xl">
              <SearchPicker<ProductView>
                label="Add item"
                placeholder="Search sellable items by SKU or name, then press Enter"
                queryKey="order-items"
                load={async (term) =>
                  (
                    await authed((t) =>
                      listProducts(t, {
                        search: term,
                        isActive: true,
                        itemRole: 'SELLABLE',
                        limit: 8,
                        offset: 0,
                      }),
                    )
                  ).products
                }
                itemKey={(p) => p.id}
                renderItem={(p) => (
                  <span>
                    <span className="font-mono text-xs">{p.sku}</span>{' '}
                    <span className="font-medium">{p.name}</span>{' '}
                    <span className="text-xs text-slate-500">{formatInr(p.sellingPrice)}</span>
                  </span>
                )}
                onPick={addItem}
                clearOnPick
              />
            </div>
          )}
          {errors.lines && <p className="mb-2 text-sm font-medium text-red-700">{errors.lines}</p>}
          {form.lines.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">
              No items yet. Search above and press Enter to add one.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Items on this order</caption>
                <thead className="text-xs text-slate-600 uppercase">
                  <tr>
                    <th scope="col" className="px-2 py-1.5">
                      Item
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Quantity
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Agreed price
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right">
                      Amount
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Customization
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {form.lines.map((l, i) => {
                    const p = `lines[${String(i)}]`;
                    return (
                      <tr key={l.key} className="align-top">
                        <td className="px-2 py-1.5">
                          <div className="font-medium text-slate-900">{l.name}</div>
                          <div className="font-mono text-xs text-slate-500">{l.sku}</div>
                          {errors[`${p}.productId`] && (
                            <div className="text-xs font-medium text-red-700">
                              {errors[`${p}.productId`]}
                            </div>
                          )}
                        </td>
                        <td className="w-28 px-2 py-1.5">
                          <input
                            aria-label={`Quantity of ${l.name}`}
                            className={`${smallInput} text-right tabular-nums ${errors[`${p}.quantity`] ? 'border-red-500' : 'border-slate-300'}`}
                            inputMode="decimal"
                            value={l.quantity}
                            disabled={readOnly}
                            onChange={(e) => editLine(l.key, { quantity: e.target.value })}
                          />
                          <div className="text-xs text-slate-500">{l.unitCode}</div>
                          {errors[`${p}.quantity`] && (
                            <div className="text-xs font-medium text-red-700">
                              {errors[`${p}.quantity`]}
                            </div>
                          )}
                        </td>
                        <td className="w-32 px-2 py-1.5">
                          <input
                            aria-label={`Agreed price of ${l.name}`}
                            className={`${smallInput} text-right tabular-nums ${errors[`${p}.agreedUnitPrice`] ? 'border-red-500' : 'border-slate-300'}`}
                            inputMode="decimal"
                            value={l.agreedUnitPrice}
                            disabled={readOnly}
                            onChange={(e) => editLine(l.key, { agreedUnitPrice: e.target.value })}
                          />
                          {errors[`${p}.agreedUnitPrice`] && (
                            <div className="text-xs font-medium text-red-700">
                              {errors[`${p}.agreedUnitPrice`]}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                          {formatInr(lineAmount(l))}
                        </td>
                        <td className="min-w-56 px-2 py-1.5">
                          <textarea
                            aria-label={`Customization for ${l.name}`}
                            rows={2}
                            maxLength={2000}
                            className={`${smallInput} h-16 py-1 ${errors[`${p}.customization`] ? 'border-red-500' : 'border-slate-300'}`}
                            placeholder="Name, colour, size, design notes…"
                            value={l.customization}
                            disabled={readOnly}
                            onChange={(e) => editLine(l.key, { customization: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {!readOnly && (
                            <button
                              type="button"
                              className="text-xs font-medium text-red-700 hover:underline"
                              aria-label={`Remove ${l.name}`}
                              onClick={() =>
                                setForm((f) => ({
                                  ...f,
                                  lines: f.lines.filter((x) => x.key !== l.key),
                                }))
                              }
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-right text-sm">
            Agreed value: <strong className="tabular-nums">{formatInr(total)}</strong>{' '}
            <span className="text-xs text-slate-500">
              (before GST; GST is worked out when an invoice is made)
            </span>
          </p>
        </Card>

        {!readOnly && (
          <div className="flex items-center gap-3">
            <Button type="submit" loading={busy}>
              {creating ? 'Save draft order' : 'Save changes'}
            </Button>
            <Link to="/orders" className="font-medium text-brand-700 hover:underline">
              Back to orders
            </Link>
          </div>
        )}
        {readOnly && (
          <Link to="/orders" className="font-medium text-brand-700 hover:underline">
            Back to orders
          </Link>
        )}
      </form>

      {!creating && (
        <Card title="History">
          <ol className="space-y-2 text-sm" aria-label="Order history">
            {loaded!.events.map((e) => (
              <li key={e.id}>
                <span className="text-xs text-slate-500">{formatDateTime(e.createdAt)}</span>{' '}
                <span className="font-medium text-slate-900">
                  {e.eventType === 'CREATED'
                    ? 'Order created'
                    : e.eventType === 'EDITED'
                      ? `Edited (${e.changedFields.join(', ')})`
                      : `${STATUS_LABEL[e.fromStatus!]} to ${STATUS_LABEL[e.toStatus!]}`}
                </span>{' '}
                <span className="text-slate-600">by {e.actorName}</span>
                {e.note && <div className="text-slate-700">Reason: {e.note}</div>}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
