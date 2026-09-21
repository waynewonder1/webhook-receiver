# Onboarding a new client (done-for-you)

Repeatable checklist for setting up a new business on the Instagram DM assistant.
Budget about 45-60 minutes per client, most of it gathering their business info.

## 0. Before you start - confirm they're a fit

- [ ] Their Instagram is a **Professional account** (Business or Creator). Personal accounts can't use the messaging API. They can switch for free in Instagram settings.
- [ ] They understand the assistant **replies automatically to every DM** on that account, with no human review first. Warn them if the account also gets personal DMs from friends.
- [ ] Agree pricing and how they pay (M-Pesa) before doing any setup.

## 1. Connect their Instagram account to your Meta app

While your Meta app is in **Development mode**, only accounts added as testers can use it. This is fine for the first few pilot clients.

- [ ] Meta Developer dashboard -> your app -> add their Instagram account as an **Instagram tester** (Roles). Ask them to accept the invite from their Instagram app (Settings -> Website permissions / Apps and websites -> Tester invites).
- [ ] On their Instagram app, turn on access to messages for connected tools (Settings -> Messages and story replies -> Connected tools -> **Allow access to messages**). Exact menu wording changes between Instagram versions. If this is off, messages never reach your webhook.
- [ ] In your Meta app's Instagram API setup, use **Generate access token** for their account and copy the token. Treat it like a password.
- [ ] Confirm the app is subscribed to the **messages** webhook field for their account.

> Later (past a handful of clients): the app needs **Meta App Review** for `instagram_business_manage_messages` before it can serve accounts that aren't testers.

## 2. Get their Instagram account ID

The webhook identifies a client by the ID of the account that *received* the DM. It must match `tenants.instagram_account_id` exactly.

Easiest way to get it right:
- [ ] Have someone DM their account from another Instagram account.
- [ ] Open the Render logs and look for: `No active tenant found for Instagram account <ID>`.
- [ ] That `<ID>` is the value to use in step 4.

## 3. Collect their business info

Ask them for (plain language is fine, you'll tidy it up):

- [ ] Business name, and one line on who they are and how they talk (friendly? formal? casual/Sheng?)
- [ ] Every product/service with **exact prices** and currency
- [ ] Sizes/options, stock notes
- [ ] How booking or ordering works, and how they get paid
- [ ] Delivery / pickup / location details
- [ ] Policies: refunds, rescheduling, cancellations
- [ ] Hours and response expectations
- [ ] Beginner-friendliness / who it's for, typical session length or turnaround
- [ ] Anything the assistant should **never** promise (discounts, delivery dates, medical claims)
- [ ] The email that should receive lead alerts

The assistant only states facts that are in the knowledge base. If it isn't written down, it will say a team member will follow up. Missing info means vague replies, so push for specifics.

## 4. Create their tenant row

Supabase -> SQL Editor. Run **once** (fill in the values; double every apostrophe inside text, e.g. `Joe''s`):

```sql
insert into tenants (
  business_name,
  instagram_account_id,
  instagram_access_token,
  notification_email,
  business_description,
  knowledge_base,
  active
) values (
  'BUSINESS NAME',
  'INSTAGRAM_ACCOUNT_ID',
  'ACCESS_TOKEN',
  'client@example.com',
  'Who they are and how they talk to customers.',
  'Prices, services, policies, logistics...',
  true
);
```

- [ ] Row created. Check it in the dashboard's **Tenants** tab (the dashboard can edit tenants but can't create them).
- [ ] Note the token's expiry date in your calendar (see "Recurring upkeep").

## 5. Decide where lead emails go

Emails sent from `onboarding@resend.dev` only deliver to the owner of your Resend account. Until you verify a domain in Resend:

- [ ] Keep `NOTIFY_OVERRIDE_EMAIL` set on Render. All lead alerts come to **you**, labelled `[Business name]`, and you forward them. Tell the client this.
- [ ] Or verify a domain in Resend, set `MAIL_FROM`, and remove `NOTIFY_OVERRIDE_EMAIL` so alerts go straight to the client.

## 6. Test before going live

From a different Instagram account, DM the client's account and check:

- [ ] An automatic reply arrives within a few seconds and sounds like the business
- [ ] The reply's prices and policies are correct. Try at least: a price question, an ordering/booking question, a "how does payment work" question, and something **not** in the knowledge base (it should say someone will follow up, not guess)
- [ ] A row appears in the dashboard **Leads** tab with the right name and a score
- [ ] The alert email arrives (with the auto-reply text included)
- [ ] Delete your test leads from `leads_v2` afterwards

Send the client a couple of the test replies and get their **OK on the wording and facts** before switching on real traffic.

## 7. Go live and hand over

- [ ] Tell the client what happens now: instant replies, every lead saved, alerts by email
- [ ] Explain what to do when a hot lead arrives (they still close the sale)
- [ ] Agree how they request knowledge-base changes (you edit it in the dashboard)

## Recurring upkeep

- [ ] **Renew the Instagram access token before it expires.** Long-lived tokens last about 60 days, and nothing in the code refreshes them yet. When it expires, replies and name lookups silently fail. Set a reminder around day 50, generate a new token, and paste it into the tenant row.
- [ ] Skim each client's recent auto-replies now and then for wrong or odd answers, and fix the knowledge base.
- [ ] Update prices in the knowledge base whenever the client's prices change.

## Offboarding

- [ ] Set `active = false` on their tenant row (don't delete it, past leads reference it):
  ```sql
  update tenants set active = false where id = TENANT_ID;
  ```
- [ ] Remove them as an Instagram tester in the Meta dashboard.
