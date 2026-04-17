# 📋 Recipe Workflow

## Two locations, two purposes

| Location | Purpose | Format |
|---|---|---|
| `/home/openclaw/.openclaw/workspace/recipes/*.md` | David's drafts / source of truth for *content* | Free-form Hebrew markdown |
| `projects/david-recipes/src/content/recipes/*.md` | Site deployment source | Structured frontmatter + body |

The site needs **structured frontmatter** (servings as number, nutrition as object, ingredients as typed lists with qty/unit) so the interactive scaler, macro card, and stat bars work. The workspace recipes are written for humans.

## Adding / updating a recipe — the flow

1. **Draft it** in `/home/openclaw/.openclaw/workspace/recipes/{slug}.md` — Chloe can help.
2. **Convert to structured form** — copy to `projects/david-recipes/src/content/recipes/{slug}.md` with frontmatter matching `src/content.config.ts`. Use `chili-con-carne-lean.md` as the template.
3. **Commit & push** — `git push` from the project dir. GitHub Actions auto-deploys to Azure SWA in ~2-3 min.

## After a "cooking session"

David updates the workspace recipe with what worked / what to fix. Then either:
- Add a new `journal:` entry to the structured version, or
- Bump `version:` and edit the body if the recipe itself changed.

Push → live in minutes.

## URLs

- **Site:** https://purple-smoke-02a2e3f03.7.azurestaticapps.net
- **Repo:** https://github.com/DavidKrispin/david-recipes (after one-time bootstrap)
