// @vitest-environment jsdom
// MTO-1: Items (roles) and Orders through the REAL screens (DOM rendered by jsdom) against the real Fastify API and a real, migrated
// PostgreSQL database. Nothing about the API is mocked or scripted. Fictional data.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { FastifyInstance } from 'fastify';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { App } from '../../apps/web/src/App.js';
import { resetAccessForTests } from '../../apps/web/src/api.js';
import { AuthProvider } from '../../apps/web/src/auth.js';
import { LAUNCH_SECRET, PASSWORD, createFixture, type Fixture } from './auth-fixture.js';
import { setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

configure({ asyncUtilTimeout: 10_000 });

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let world: BillingWorld;
let sent: { method: string; url: string }[];
const realFetch = globalThis.fetch;
const users: Record<string, string> = {};

function renderApp(path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function signInAs(username: string) {
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const field = (text: string) =>
  screen.getByLabelText(new RegExp(`^${esc(text)}( \\((required|optional)\\))?$`));
const typeIn = (text: string, value: string) =>
  fireEvent.change(field(text), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const writes = () => sent.filter((s) => s.method !== 'GET' && !s.url.includes('/auth/'));

async function newUser(role: string, name: string) {
  await app.authService!.createUser({
    organizationId: fx.orgId,
    username: name,
    displayName: `${role} (test)`,
    password: PASSWORD,
    roleNames: [role],
  });
  users[role] = name;
}
/** Picks an item through the keyboard-first search box and returns its option text. */
async function pickItem(label: string, search: string, optionName: RegExp) {
  const box = screen.getByRole('combobox', { name: label });
  fireEvent.change(box, { target: { value: search } });
  fireEvent.mouseDown(await screen.findByRole('option', { name: optionName })); // the picker chooses on mouse-down
}
async function openOrders() {
  fireEvent.click(await screen.findByRole('link', { name: 'Orders' }));
  return screen.findByRole('heading', { name: 'Orders' });
}

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  world = await setupBillingWorld(fx);
  await fx.prisma.product.create({
    data: {
      organizationId: fx.orgId,
      sku: 'MAT-PLA-1',
      name: 'PLA Filament Black (fictional)',
      kind: 'GOODS',
      itemRole: 'RAW_MATERIAL',
      unitId: world.unit.pcs,
      taxCategoryId: world.taxId.GST_18,
      sellingPrice: null,
      trackInventory: true,
    } as never,
  });
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'silent' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await newUser('Administrator', 'ui.admin');
  await newUser('Viewer/Auditor', 'ui.viewer');
  await newUser('Warehouse Operator', 'ui.warehouse');
}, 180_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await fx?.close();
});

beforeEach(() => {
  sent = [];
  resetAccessForTests();
  window.commercebill = {
    getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
    getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
    saveInvoicePdf: async () => ({ status: 'cancelled' }),
    printInvoice: async () => ({ status: 'cancelled' }),
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', url: String(url) });
    return realFetch(url, init);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  delete window.commercebill;
  globalThis.fetch = realFetch;
});

describe('Items: roles and fulfilment through the real UI', () => {
  it('lists the item roles, filters by role and shows a material with no price', async () => {
    renderApp('/products');
    await signInAs(users['Administrator']!);
    expect(await screen.findByRole('heading', { name: 'Items' })).toBeTruthy();
    expect(await screen.findByText('PLA Filament Black (fictional)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Item role'), { target: { value: 'RAW_MATERIAL' } });
    await waitFor(() => expect(screen.queryByText('Untracked Gadget')).toBeNull());
    const row = screen.getByText('PLA Filament Black (fictional)').closest('tr')!;
    expect(within(row).getByText('Raw material')).toBeTruthy();
    expect(within(row).getByText('Not sold')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Item role'), { target: { value: 'SELLABLE' } });
    expect(await screen.findByText('Untracked Gadget')).toBeTruthy();
    expect(screen.queryByText('PLA Filament Black (fictional)')).toBeNull();
    const gadget = screen.getByText('Untracked Gadget').closest('tr')!;
    expect(within(gadget).getByText('Made to order')).toBeTruthy();
  });

  it('creates a raw material without a price; the form hides pricing and shows the role', async () => {
    renderApp('/products/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New item' });
    expect(screen.getByRole('group', { name: 'Item role' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^Raw material/));
    expect(screen.queryByRole('group', { name: 'Product type' })).toBeNull();
    expect(screen.queryByLabelText(/^Selling price/)).toBeNull(); // not sold, so no price
    typeIn('Product name', 'Acrylic Sheet 3mm (fictional)');
    fireEvent.change(field('Unit of measure'), { target: { value: world.unit.pcs } });
    fireEvent.change(field('Tax category'), { target: { value: world.taxId.GST_18 } });
    click('Create item');
    await screen.findByText(/was created/);
    const created = await fx.prisma.product.findFirstOrThrow({
      where: { name: 'Acrylic Sheet 3mm (fictional)' },
    });
    expect(created).toMatchObject({
      itemRole: 'RAW_MATERIAL',
      kind: 'GOODS',
      fulfilmentMode: null,
      trackInventory: true,
    });
    expect(created.sellingPrice).toBeNull();
  });

  it('a sellable item shows its fulfilment mode, which follows stock tracking', async () => {
    renderApp('/products/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New item' });
    expect(screen.getByText(/Made to order/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^Track inventory/));
    expect(screen.getByText(/Finished stock is held/)).toBeTruthy();
  });

  it('a material never appears in the billing item search', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: /New (demo )?invoice/i });
    // choose a customer first (the item box is disabled until then)
    const cust = screen.getByRole('combobox', { name: /Customer/i });
    fireEvent.change(cust, { target: { value: 'Walk-in' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Walk-in Buyer/ }));
    const box = screen.getByRole('combobox', { name: 'Add item' });
    fireEvent.change(box, { target: { value: 'PLA' } });
    await screen.findByText('No matches');
    expect(
      sent.some((s) => s.url.includes('/products?') && s.url.includes('itemRole=SELLABLE')),
    ).toBe(true);
    fireEvent.change(box, { target: { value: 'Untracked' } });
    expect(await screen.findByRole('option', { name: /Untracked Gadget/ })).toBeTruthy();
  });
});

describe('Orders through the real UI, API and database', () => {
  it('shows the empty state, then creates a draft order with a customization and opens it', async () => {
    renderApp('/');
    await signInAs(users['Administrator']!);
    await openOrders();
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New order' })[0]!); // header and empty-state buttons
    await screen.findByRole('heading', { name: 'New order' });
    fireEvent.change(field('Source'), { target: { value: 'INSTAGRAM' } });
    typeIn('Buyer name', 'Anita Rao (fictional)');
    typeIn('Buyer phone', '98450 12345');
    typeIn('Delivery: address line 1', '14 Workshop Lane');
    typeIn('Delivery: city', 'Pune');
    fireEvent.change(field('Delivery: state'), { target: { value: '27' } });
    typeIn('Delivery: PIN code', '411001');
    typeIn('Due date', '2099-02-14');
    await pickItem('Add item', 'Untracked', /Untracked Gadget/);
    fireEvent.change(await screen.findByLabelText('Quantity of Untracked Gadget'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Agreed price of Untracked Gadget'), {
      target: { value: '199.50' },
    });
    fireEvent.change(screen.getByLabelText('Customization for Untracked Gadget'), {
      target: { value: 'Name: Anita, blue, 8x10' },
    });
    expect(screen.getAllByText('₹598.50', { exact: false }).length).toBeGreaterThan(0); // 3 x 199.50 shown while typing
    click('Save draft order');
    expect(await screen.findByRole('heading', { name: /^Order SO\// })).toBeTruthy();
    expect(await screen.findByText(/was saved as a draft/)).toBeTruthy();
    const o = await fx.prisma.salesOrder.findFirstOrThrow({ include: { lines: true } });
    expect(o).toMatchObject({
      status: 'DRAFT',
      channel: 'INSTAGRAM',
      buyerName: 'Anita Rao (fictional)',
    });
    expect(o.totalAmount.toFixed(2)).toBe('598.50');
    expect(o.lines[0]).toMatchObject({ customization: 'Name: Anita, blue, 8x10' });
    expect(writes().filter((w) => w.method === 'POST' && w.url.endsWith('/orders'))).toHaveLength(
      1,
    );
  });

  it('lists the order with source, buyer, due date, status and agreed value', async () => {
    renderApp('/orders');
    await signInAs(users['Administrator']!);
    const row = (await screen.findByText('Anita Rao (fictional)')).closest('tr')!;
    expect(within(row).getByText(/^SO\//)).toBeTruthy();
    expect(within(row).getByText('Instagram')).toBeTruthy();
    expect(within(row).getByText('Draft')).toBeTruthy();
    expect(within(row).getByText('₹598.50')).toBeTruthy();
    expect(within(row).getByText('1 item')).toBeTruthy();
    // search and filter
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nobody-here' } });
    expect(await screen.findByText('No orders match')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'CONFIRMED' } });
    expect(await screen.findByText('No orders match')).toBeTruthy();
  });

  it('edits a draft, confirms it, asks for a reason where one is needed, and shows the history', async () => {
    renderApp('/orders');
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: /^Open order SO\// }));
    await screen.findByRole('heading', { name: /^Order SO\// });
    typeIn('Notes', 'Gift wrap please');
    click('Save changes');
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    click('Confirm order');
    click(/^Confirm: Confirm order/);
    expect(await screen.findByText(/The order is now confirmed/)).toBeTruthy();
    // a reason is needed to mark the order as needing information
    click('Needs information');
    click(/^Confirm: Needs information/);
    expect(await screen.findByText('Please give a short reason.')).toBeTruthy();
    typeIn('Reason', 'Customer must confirm the spelling');
    click(/^Confirm: Needs information/);
    await screen.findByText(/The order is now needs information/);
    const history = within(screen.getByRole('list', { name: 'Order history' }));
    expect(history.getByText(/Order created/)).toBeTruthy();
    expect(history.getByText(/Edited \(notes\)/)).toBeTruthy();
    expect(history.getByText(/Draft to Confirmed/)).toBeTruthy();
    expect(history.getByText(/Confirmed to Needs information/)).toBeTruthy();
    expect(history.getByText(/Reason: Customer must confirm the spelling/)).toBeTruthy();
    const o = await fx.prisma.salesOrder.findFirstOrThrow();
    expect(o.status).toBe('NEEDS_INFO');
  });

  it('shows the version conflict when someone else changed the order, and loses nothing silently', async () => {
    renderApp('/orders');
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: /^Open order SO\// }));
    await screen.findByRole('heading', { name: /^Order SO\// });
    // someone else saves first
    await fx.prisma.salesOrder.updateMany({
      data: { notes: 'Changed elsewhere', version: { increment: 1 } },
    });
    typeIn('Notes', 'My late edit');
    click('Save changes');
    expect(await screen.findByText(/was changed by someone else/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the order' })).toBeTruthy();
    const o = await fx.prisma.salesOrder.findFirstOrThrow();
    expect(o.notes).toBe('Changed elsewhere');
  });

  it('a closed order is read-only with no save button and no status actions', async () => {
    const o = await fx.prisma.salesOrder.findFirstOrThrow();
    await fx.prisma
      .$executeRawUnsafe(`UPDATE sales_orders SET status = 'CONFIRMED' WHERE id = '${o.id}'`)
      .catch(() => undefined);
    await fx.prisma.$executeRawUnsafe(
      `UPDATE sales_orders SET status = 'CLOSED' WHERE id = '${o.id}'`,
    );
    renderApp(`/orders/${o.id}`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByText(/can no longer be changed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Cancel order|Close order|Confirm order/ }),
    ).toBeNull();
    expect((field('Buyer name') as HTMLInputElement).disabled).toBe(true);
  });

  it('read-only people see orders but no New order button and no editing', async () => {
    renderApp('/orders');
    await signInAs(users['Viewer/Auditor']!);
    expect(await screen.findByText('Anita Rao (fictional)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New order' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /^Open order SO\// }));
    expect(await screen.findByText('You can view this order but not change it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(writes().filter((w) => w.url.includes('/orders'))).toHaveLength(0);
  });

  it('a marketplace-style order needs no customer record: the buyer snapshot stands alone', async () => {
    renderApp('/orders/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New order' });
    fireEvent.change(field('Source'), { target: { value: 'AMAZON' } });
    typeIn('External order ID', '402-1234567-7654321');
    typeIn('Buyer name', 'Marketplace Buyer (fictional)');
    typeIn('Delivery: address line 1', '5 Lake Road');
    fireEvent.change(field('Delivery: state'), { target: { value: '29' } });
    await pickItem('Add item', 'Untracked', /Untracked Gadget/);
    click('Save draft order');
    await screen.findByRole('heading', { name: /^Order SO\// });
    const o = await fx.prisma.salesOrder.findFirstOrThrow({
      where: { externalOrderId: '402-1234567-7654321' },
    });
    expect(o).toMatchObject({ channel: 'AMAZON', customerId: null });
    // the same external id again is refused with a plain message
    cleanup();
    resetAccessForTests();
    renderApp('/orders/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New order' });
    fireEvent.change(field('Source'), { target: { value: 'AMAZON' } });
    typeIn('External order ID', '402-1234567-7654321');
    typeIn('Buyer name', 'Someone Else');
    typeIn('Delivery: address line 1', '1 Road');
    fireEvent.change(field('Delivery: state'), { target: { value: '27' } });
    await pickItem('Add item', 'Untracked', /Untracked Gadget/);
    click('Save draft order');
    expect(await screen.findByText('This is already used.')).toBeTruthy();
  });

  it('the dashboard shows the open orders from the database', async () => {
    renderApp('/');
    await signInAs(users['Administrator']!);
    const card = await screen.findByRole('region', { name: 'Orders' });
    expect(within(card).getByText(/open order/)).toBeTruthy();
  });

  it('a role without order access sees no Orders entry', async () => {
    await fx.prisma.rolePermission.deleteMany({
      where: { permission: { key: 'sales.order.read' }, role: { name: 'Warehouse Operator' } },
    });
    renderApp('/');
    await signInAs(users['Warehouse Operator']!);
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByRole('link', { name: 'Orders' })).toBeNull();
  });
});
