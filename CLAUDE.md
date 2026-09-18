# SecureDoc — working agreements

## How a change ends (owner's standing instruction, 2026-09-18)

Always, in this order, without being asked again:

1. **Commit everything** — nothing is left uncommitted in the working tree.
2. **Push.** The work lands on `main`: push it there (if it was committed on a branch a session was
   told to use, move `main` onto it with `git merge --ff-only <branch>` and push `main`).
3. **Then switch the folder to `main` and update it** — `git checkout main && git pull origin main`,
   so the checkout ends on an up-to-date `main` and the change is visible when the app is run.

No pull request unless it is asked for by name.
