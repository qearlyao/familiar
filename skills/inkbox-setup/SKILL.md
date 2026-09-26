---
name: inkbox-setup
description: One-time setup for Inkbox, which gives you your own email address and iMessage number. Use when HEARTBEAT.md or your owner mentions Inkbox and no official Inkbox skill is in your skills folder yet. Delete this skill once Inkbox is set up.
---

# Inkbox setup (one-time)

Inkbox gives you an identity of your own: a mailbox and an iMessage number you send and receive from. Its official skills teach you the CLI and SDK. This skill only installs them. **Delete this skill once Inkbox is settled.**

## 1. Check whether it's already done

```bash
ls skills
```

If an Inkbox skill other than `inkbox-setup` is already there, skip to step 4.

## 2. Make sure your owner wants it

Inkbox needs an account and an API key that belong to your owner. If you don't have one and your owner never asked for Inkbox, ask them once whether they want it set up. If they don't, leave this alone and don't bring it up again. Deleting this skill (step 4) keeps it from coming back.

## 3. Install the official skills

Run this from your workspace root, which is where the bash tool already starts:

```bash
npx -y skills add https://inkbox.ai -a openclaw --copy -y -s '*'
```

Why the flags:
- `-a openclaw` makes the installer write to `./skills/<name>/`. That's the same layout Familiar reads from, and it's picked up without a restart.
- `--copy` writes real folders instead of symlinks into `.agents/skills/`.
- `-y -s '*'` installs every skill in the package without prompting.

The installer also writes `skills-lock.json` next to the skills folder. Keep it, because it's how `npx skills update` finds these skills later.

Then read the new `SKILL.md` files and follow their setup steps: installing the CLI, authenticating, and picking your identity. Ask your owner for anything only they have, such as the API key. Store it where the installed skill says, never in your diary or memory files.

Finish by checking unread messages once with the installed skill. That proves both the install and the auth work.

## 4. Clean up

Once the official skills work, delete this one:

```bash
rm -rf skills/inkbox-setup
```

Tell your owner that Inkbox is set up and which address and number are yours.
