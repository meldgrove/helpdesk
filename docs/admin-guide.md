# Admin guide

For admins and superadmins: the request form, categories, email, Slack and
people. Roles come from the sign-in provider's groups
([Identity and access](identity-and-access.md)).

## First steps

1. Sign in with an address in `SUPERADMIN_EMAILS` (or as a member of the
   superadmin group).
2. **Email & Slack** (superadmins): set up email, so requesters hear about
   their requests, and Slack, if you want new tickets in a channel.
3. **Request form → Categories**: name the kinds of requests you handle,
   e.g. "IT", "Finance", "Office". Optionally give each a default assignee.
4. **Request form → Questions**: ask what you need to know, with show-if
   rules for questions that only matter in some cases.
5. Send a test request as a requester and work on it on the **Board**.

## The request form

There is one form. It has pages; requesters see one page at a time, then
check their answers and send them.

- **The first page** always holds three questions that every ticket needs:
  the title, the category and the urgency. You can change their wording and
  order, not remove them.
- **Question types:** short text, long text, single choice, multiple
  choice, date, number, email, checkbox (for "I confirm …") and files.
- **Show if:** a page or question can appear only when earlier answers
  match, e.g. a page "Laptop" only when the category is "IT", or a question
  "Why is it urgent?" only when the urgency is "Very urgent". Rules can refer
  only to questions that come earlier. A hidden question is never required,
  and answers to it are not kept.
- **Saving publishes** a new version at once. Tickets keep the questions and
  answers as they were asked, so changing the form never changes old
  tickets. When someone else saved in between, reload first.

## Categories

The answers to the category question, and the filter on the board. A
**default assignee** gets every new ticket of the category (and an email or
Slack message about it). An inactive category is no longer offered, but its
tickets keep it. At least one category stays active.

## Working on tickets

- **Board:** one column per status. Drag a card to change its status or its
  order in the column; each card's menu does the same with the keyboard.
  Done and cancelled show the last 14 days; the **All tickets** list shows
  everything.
- **A ticket** has its answers, the conversation and its activity. **Reply
  to requester** sends the requester an email; an **internal note** stays
  with staff (also its files). Change the status, urgency, category,
  assignee and due date on the side.
- **Waiting for requester:** a reply of the requester moves the ticket back
  to In progress.
- **Done:** the requester gets an email. A reply within 14 days reopens the
  ticket; after that, or when it was cancelled, they send a new request.
- **New ticket:** record a request for someone, e.g. after a phone call.
  The requester gets the same email as for the form.

## Notifications

| Who           | When                                                                | How                              |
| ------------- | ------------------------------------------------------------------- | -------------------------------- |
| Requester     | The request was received, staff replied, the ticket is done         | Email                            |
| Slack channel | A new ticket; a requester replied to a ticket nobody is assigned to | Slack                            |
| Assignee      | A ticket was assigned to them; the requester replied                | Email, or Slack if they chose it |

Each person chooses email or Slack in **My settings**. A Slack direct
message needs a Slack account with the same email address; otherwise the
message goes by email. Staff get no message about their own changes. Emails
go out in the person's language.

## Email (superadmins)

- **SMTP:** host, port, security (TLS on port 465, STARTTLS on 587), user
  and password of your mail server.
- **MailerSend:** an API token with permission to send email, and a sender
  address on a domain verified in MailerSend.

Send a test email after saving. Emails say that replies to them are not
read: people reply in the app.

## Slack (superadmins)

1. At https://api.slack.com/apps create an app **from scratch** in your
   workspace.
2. Under **OAuth & Permissions → Bot Token Scopes** add `chat:write`,
   `users:read`, `users:read.email`, and for the channel picker
   `channels:read` and `groups:read`.
3. **Install to Workspace** and copy the **Bot User OAuth Token**
   (`xoxb-…`) into the app.
4. Invite the bot to the channel for new tickets (`/invite @<bot name>`)
   and choose that channel.
5. Post a test message.

## People

The **People** page lists everyone the app knows, with their role and where
it came from (directory sync, sign-in or `SUPERADMIN_EMAILS`). Roles change
in the sign-in provider, not here. With Keycloak, superadmins can check the
connection and sync now.

## Audit log

Superadmins see who changed the form, categories, email, Slack and the
directory sync, and when. It never holds passwords or tokens.
