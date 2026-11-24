# Connect Gmail to the Comms agent

A one-time setup of about 15 minutes. `<your-server>` below is the machine that runs the connector (an SSH alias or `user@host`). When it is done, the Comms agent in HomeBase can read your mail and save drafts, new mail shows up in the HomeBase inbox, and nothing is ever sent without your approval on the phone.

What HomeBase gets, and what it does not:

| It can | It cannot |
|---|---|
| Search and read mail (`gmail.readonly`) | Delete, archive or trash mail |
| Create, change and list drafts (`gmail.compose`) | Add or remove labels, mark mail read or unread |
| Send a draft, only after you approve that exact email in the app | Create filters or forwarding, change any setting |

Google enforces the left column through the two scopes. HomeBase enforces it again in its own code: the connector has no delete, label, filter, forwarding or settings call at all. If either scope list ever shows more than these two, stop and do not approve.

You never type your Google password into HomeBase or into a terminal. You sign in on Google's own page, in your own browser.

The sign-in token is stored on the connector machine only, in `~/homebase-data/secrets/gmail-token.json`, readable only by your user. It is never sent to the hub or to the phone and never written to a log.

## 1. Google Cloud project

1. Open <https://console.cloud.google.com/> signed in as the mailbox owner (for Workspace: an account in your organisation that may create projects).
2. Project picker at the top → **New project**. Name it `HomeBase`. Create it and select it.
3. **APIs & Services → Library**, search for **Gmail API**, open it, **Enable**. Pick the plain "Gmail API", not anything called "Gmail MCP API".

## 2. Consent screen

Open **APIs & Services → OAuth consent screen** (the console now calls this area **Google Auth Platform**; the pages below are in its left menu). If asked, click **Get started**.

**Branding**: app name `HomeBase`, your email as the support and developer contact.

**Audience**: choose by the kind of mailbox.

| Your mailbox | Choose | Notes |
|---|---|---|
| Google Workspace (you@yourcompany.com) | **Internal** | Only people in your organisation can sign in. No test users, no warning page, and the sign-in does not expire. |
| Personal Gmail (you@gmail.com) | **External** | Add your own address under **Test users**. Read the next paragraph. |

**External, and the 7-day expiry.** A new External app starts in publishing status **Testing**. In Testing, Google expires the sign-in after 7 days, so the Comms agent would show "Gmail access expired or was revoked" every week and you would run step 6 again. To avoid that, on the **Audience** page click **Publish app** so the status reads **In production**. You do not need to submit it for verification for personal use: an unverified app in production still works for you, it just shows a "Google hasn't verified this app" page during sign-in (click **Advanced → Go to HomeBase (unsafe)**; it is your own app). Unverified apps are limited to 100 users, which does not matter for one mailbox.

If you prefer to stay in Testing, everything works; you repeat step 6 weekly.

## 3. Data Access: exactly two scopes

Open **Data Access → Add or remove scopes**. In the filter box search `gmail` and tick exactly these two:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`

If they are not in the list, paste both lines into **Manually add scopes** and click **Add to table**. Click **Update**, then **Save**.

Do not add `gmail.modify`, `https://mail.google.com/`, `gmail.send`, `gmail.settings.*` or anything else. HomeBase asks only for the two above, and its sign-in command refuses to continue if Google grants anything more.

## 4. OAuth client: Desktop app

1. Open **Clients → Create client** (older console: **Credentials → Create credentials → OAuth client ID**).
2. Application type: **Desktop app**. Name: `HomeBase connector`. If there is an "AI-powered agent" box, leave it unticked.
3. **Create**, then **Download JSON**. The file is named like `client_secret_1234-abc.apps.googleusercontent.com.json`.

"Desktop app" matters: HomeBase's sign-in uses a loopback address (`http://127.0.0.1:53682/`), which Google allows for Desktop clients without registering it. A "Web application" client file is rejected by HomeBase with a message saying so.

## 5. Put the file on the server

From your computer, in the folder where the file was downloaded:

```
ssh <your-server> "mkdir -p ~/homebase-data/secrets && chmod 700 ~/homebase-data/secrets"
scp client_secret_*.json <your-server>:~/homebase-data/secrets/google-oauth-client.json
ssh <your-server> "chmod 600 ~/homebase-data/secrets/google-oauth-client.json"
```

Then delete the downloaded copy. (The client file is not the key to your mailbox; the token from step 6 is. It still should not lie around.)

## 6. Sign in (once)

```
ssh <your-server>
cd ~/homebase
npm run gmail:auth -w @homebase/connector
```

The command prints a long Google address. Then:

1. Copy the address into the browser **on your own computer or phone** and sign in with the mailbox HomeBase should use.
2. Google lists what HomeBase asks for: read your mail, and manage drafts and send mail. Keep both ticked and continue. If it lists anything else, close the page.
3. The browser is sent to an address starting with `http://127.0.0.1:53682/?state=...&code=...` and shows **"This site can't be reached"**. That is expected: the address points at the server, not at your computer.
4. Copy that **whole address** from the address bar, paste it into the terminal and press Enter.

The command then prints the connected account and the granted scopes, and stores the token. It refuses, stores nothing and revokes the grant if Google granted any scope beyond the two.

Within a minute the "Gmail not connected" note on the Comms agent disappears in the app, and the agent's page shows the account, the two scopes and the time of the last inbox poll.

**If you would rather not copy the address back**, open a tunnel from your computer *before* opening the Google address, in a second terminal, and leave it open until the page says HomeBase received the answer:

```
ssh -N -L 53682:127.0.0.1:53682 <your-server>
```

With the tunnel open, the browser reaches the server through `127.0.0.1:53682` and the sign-in finishes by itself. Close the tunnel with Ctrl+C afterwards.

A different client file can be given as an argument: `npm run gmail:auth -w @homebase/connector -- /path/to/client.json`.

## 7. Check it

```
npm run gmail:status -w @homebase/connector
```

It prints the account and the scopes as Google reports them right now, and never the token. In the app, open **Agents → Comms agent**: the **Gmail** card shows Connected, your address, `gmail.readonly, gmail.compose` and the last poll time.

New mail arrives in the HomeBase inbox within about 3 minutes. Open a mail item and tap **Draft reply with Comms agent**, or open a chat with the agent and ask, for example, "What came in today?" or "Draft a reply to Sam saying Friday works".

## How it behaves

- **Modes.** The agent starts in **Manual**: it asks before saving each draft. In **Auto** it saves drafts without asking.
- **Sending is always your decision.** In every mode, a send stops inside the connector and shows you a high-risk approval with From, To, Cc, Bcc, Subject and the full text, read back from Gmail. Recipients who were not on the thread before are marked. If you reject it, the agent is told "DENIED" and the draft stays in Gmail. At most 10 emails can be sent per hour (set `HB_GMAIL_SEND_CAP` in `~/.config/homebase/homebase.env` to change it).
- **Email text is treated as untrusted.** The agent is told never to follow instructions found in mail. Hidden text (HTML comments, invisible characters, `display:none`) is removed before the agent sees a mail. Mail that looks like it is trying to instruct an AI raises a P1 inbox item, "Possible prompt-injection in email from …".
- **Your mail stays in Gmail.** HomeBase's inbox keeps only sender, subject and snippet. The agent reads the full text from Gmail when you ask it to. Nothing is marked read and nothing is labelled.
- **Drafts are signed with your name** if you add `HB_COMMS_OWNER_NAME=YourFirstName` to `~/.config/homebase/homebase.env` and restart the connector (`systemctl --user restart homebase-connector`).

## Revoke access

Either of these ends HomeBase's access at once. Doing both is fine.

On the server (tells Google to revoke the grant and deletes the stored token):

```
cd ~/homebase && npm run gmail:revoke -w @homebase/connector
```

From Google, on any device: <https://myaccount.google.com/permissions> → **HomeBase** → **Delete all connections** (wording varies: "Remove access"). Workspace admins can also block the app under **Security → API controls**.

After either, the Comms agent shows "Gmail not connected" (or "Gmail access expired or was revoked") within a few minutes and its runs fail at once with that message. To connect again, run step 6.

To remove everything: revoke as above, delete `~/homebase-data/secrets/google-oauth-client.json` on the server, and delete the OAuth client (or the whole project) in Google Cloud.

## Troubleshooting

| You see | Cause and fix |
|---|---|
| "Gmail not connected — put google-oauth-client.json in ~/homebase-data/secrets…" | Step 5 has not been done, or the file has another name. |
| "Gmail not connected — run gmail:auth on <host>" | The client file is there; do step 6. |
| "Gmail access expired or was revoked" | External app still in Testing (7 days), you removed access at Google, or you changed your Google password. Run step 6 again; see step 2 to stop the weekly expiry. |
| `Error 403: access_denied` on Google's page | External app in Testing and your address is not under Test users (step 2). |
| `Error 400: redirect_uri_mismatch` | The client is not of type Desktop app. Redo step 4. |
| `REFUSED. Google granted more than HomeBase asked for` | The Google account had already granted this client other scopes. Remove HomeBase at <https://myaccount.google.com/permissions>, check step 3 lists only the two scopes, run step 6 again. |
| `REFUSED. Google did not grant …` | A box was unticked on the consent page. Run step 6 again and keep both ticked. |
| "The state value does not match" | The pasted address came from an older attempt. Run the command again and use the new address. |
| Workspace: "Access blocked: your organisation's admin must review HomeBase" | In the Workspace admin console, **Security → API controls → App access control**, mark the HomeBase client as trusted. |
