# SecureDoc — working agreements

## Git

- **Everything goes onto `main`.** Commit on `main` and `git push -u origin main`; the owner wants
  the change visible in the checkout right after it is pushed (standing instruction, 2026-09-18).
- This holds over a branch a session is told to use: if the work was done on such a branch, move
  `main` onto it (`git merge --ff-only <branch>`) and push `main`.
- No pull request unless it is asked for by name.
