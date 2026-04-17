# 📖 ספר המתכונים של דוד

A personal Hebrew RTL recipe site built with [Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com), deployed to Azure Static Web Apps.

## ✨ Features

- **Full Hebrew RTL** with Heebo + Rubik web fonts
- **Astro Content Collections** — recipes are markdown files with structured frontmatter
- **Interactive ingredient checklist** (persists in `localStorage`)
- **Interactive step checklist** (persists in `localStorage`)
- **Servings scaler** — change servings, all quantities recalculate
- **Macro breakdown card** with visual stacked bar (protein/carbs/fat/fiber)
- **Quick stats** — prep / cook / total time, servings, calories
- **Print-friendly** stylesheet (`window.print()`)
- **Dark mode** toggle with system-preference fallback
- **Tag filtering** + free-text search on home page
- **Cooking journal** — version history per recipe (rating, what worked, improvements)
- Auto-deploy via **GitHub Actions** → **Azure Static Web Apps**

## 🛠 Local development

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # produces ./dist
npm run preview
```

## 📝 Adding a recipe

Add a markdown file under `src/content/recipes/` with frontmatter matching the schema in `src/content.config.ts`.

The source-of-truth recipes live in the workspace at `/home/openclaw/.openclaw/workspace/recipes/*.md`. To bring a new recipe into the site, copy it into `src/content/recipes/` (with the structured frontmatter) and push.

## 🚀 Deployment

Every push to `main` triggers the GitHub Actions workflow at `.github/workflows/azure-static-web-apps.yml`, which builds the site and deploys to Azure Static Web Apps.

The deployment token is stored as the GitHub secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
