#!/usr/bin/env node
/**
 * Recipe Sync Script
 * Converts workspace recipes/*.md → Astro content format → pushes to site
 *
 * Usage:
 *   node sync-recipes.js              # Convert all & deploy
 *   node sync-recipes.js --watch      # Watch for changes & auto-deploy
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE_RECIPES = '/home/openclaw/.openclaw/workspace/recipes';
const SITE_RECIPES = '/home/openclaw/.openclaw/workspace/projects/david-recipes/src/content/recipes';
const SITE_ROOT = '/home/openclaw/.openclaw/workspace/projects/david-recipes';

// Parse a workspace recipe markdown into structured frontmatter
function parseRecipe(content, filename) {
  const lines = content.split('\n');
  const recipe = {
    title: '',
    emoji: '',
    description: '',
    version: 'v1',
    date: new Date().toISOString().split('T')[0],
    servings: 4,
    prepMinutes: null,
    cookMinutes: null,
    difficulty: 'בינוני',
    tags: [],
    nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
    ingredientGroups: [],
    steps: [],
    serving: [],
    equipment: [],
    storage: [],
    nextTime: [],
    journal: [],
  };

  // Extract title (first # heading)
  const titleMatch = content.match(/^#\s+(.+)/m);
  if (titleMatch) {
    const raw = titleMatch[1].trim();
    // Extract emoji from title
    const emojiMatch = raw.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s*/u);
    if (emojiMatch) {
      recipe.emoji = emojiMatch[1];
      recipe.title = raw.replace(emojiMatch[0], '').trim();
    } else {
      recipe.title = raw;
    }
  }

  // Extract version
  const versionMatch = content.match(/\*\*גרסה:\*\*\s*(v\d+)/);
  if (versionMatch) recipe.version = versionMatch[1];

  // Extract date
  const dateMatch = content.match(/\*\*תאריך:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) recipe.date = dateMatch[1];

  // Extract servings from the "מנות:" line
  const servingsMatch = content.match(/\*\*מנות:\*\*\s*(\d+)/);
  if (servingsMatch) recipe.servings = parseInt(servingsMatch[1]);

  // Extract nutrition from "מנות" line or macro section
  const calMatch = content.match(/(\d+)\s*קק"ל/);
  if (calMatch) recipe.nutrition.calories = parseInt(calMatch[1]);

  const proteinMatch = content.match(/(\d+)g\s*חלבון/);
  if (proteinMatch) recipe.nutrition.protein = parseInt(proteinMatch[1]);

  const carbsMatch = content.match(/(\d+)g\s*פחמ/);
  if (carbsMatch) recipe.nutrition.carbs = parseInt(carbsMatch[1]);

  const fatMatch = content.match(/(\d+)g\s*שומן/);
  if (fatMatch) recipe.nutrition.fat = parseInt(fatMatch[1]);

  const fiberMatch = content.match(/(\d+)g\s*סיב/);
  if (fiberMatch) recipe.nutrition.fiber = parseInt(fiberMatch[1]);

  // Parse sections
  let currentSection = '';
  let currentIngredientGroup = null;
  let inJournal = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section headers
    if (line.startsWith('## ')) {
      const header = line.replace(/^##\s+/, '').trim();
      if (header.includes('רכיבים')) currentSection = 'ingredients';
      else if (header.includes('הכנה')) currentSection = 'steps';
      else if (header.includes('הגשה')) currentSection = 'serving';
      else if (header.includes('ציוד')) currentSection = 'equipment';
      else if (header.includes('אחסון') || header.includes('שמירה')) currentSection = 'storage';
      else if (header.includes('דרוש') || header.includes('פעם הבאה')) currentSection = 'nextTime';
      else if (header.includes('יומן') || header.includes('journal')) { currentSection = 'journal'; inJournal = true; }
      else if (header.includes('טיפ')) currentSection = 'tips';
      else currentSection = '';
      continue;
    }

    // Sub-headers for ingredient groups
    if (line.startsWith('### ') && currentSection === 'ingredients') {
      const groupTitle = line.replace(/^###\s+/, '').trim();
      currentIngredientGroup = { title: groupTitle, items: [] };
      recipe.ingredientGroups.push(currentIngredientGroup);
      continue;
    }

    // Parse ingredient lines
    if (currentSection === 'ingredients' && line.startsWith('- ')) {
      if (!currentIngredientGroup) {
        currentIngredientGroup = { title: 'עיקרי', items: [] };
        recipe.ingredientGroups.push(currentIngredientGroup);
      }
      const item = parseIngredient(line.replace(/^-\s*/, ''));
      if (item) currentIngredientGroup.items.push(item);
      continue;
    }

    // Parse steps
    if (currentSection === 'steps' && /^\d+\./.test(line)) {
      const step = line.replace(/^\d+\.\s*/, '').trim();
      if (step) recipe.steps.push(step);
      continue;
    }

    // Parse serving/equipment/storage/nextTime
    if (['serving', 'equipment', 'storage', 'nextTime'].includes(currentSection) && line.startsWith('- ')) {
      recipe[currentSection].push(line.replace(/^-\s*/, '').trim());
      continue;
    }

    // Parse journal entries
    if (currentSection === 'journal' && line.startsWith('### ')) {
      const jMatch = line.match(/###\s+(v\d+)\s*[—-]\s*(\d{4}-\d{2}-\d{2})?/);
      if (jMatch) {
        const entry = { version: jMatch[1], date: jMatch[2] || recipe.date };
        // Read subsequent lines for journal content
        let j = i + 1;
        const notes = [];
        while (j < lines.length && !lines[j].trim().startsWith('### ') && !lines[j].trim().startsWith('## ') && !lines[j].trim().startsWith('<!--')) {
          const jl = lines[j].trim();
          if (jl.startsWith('- **דירוג:**')) {
            const rm = jl.match(/(\d+)/);
            if (rm) entry.rating = parseInt(rm[1]);
          } else if (jl.startsWith('- **מה עבד:**')) {
            entry.worked = jl.replace(/^-\s*\*\*מה עבד:\*\*\s*/, '');
          } else if (jl.startsWith('- **מה לשפר:**')) {
            entry.improve = jl.replace(/^-\s*\*\*מה לשפר:\*\*\s*/, '');
          } else if (jl.startsWith('- **שינויים')) {
            entry.changes = jl.replace(/^-\s*\*\*שינויים.*?:\*\*\s*/, '');
          } else if (jl.startsWith('_') || jl.length > 0) {
            notes.push(jl.replace(/^_|_$/g, ''));
          }
          j++;
        }
        if (notes.length) entry.notes = notes.filter(n => n).join(' ');
        recipe.journal.push(entry);
        i = j - 1;
      }
    }
  }

  // Infer tags from content
  if (recipe.tags.length === 0) {
    const text = content.toLowerCase();
    if (text.includes('עוף') || text.includes('chicken')) recipe.tags.push('עוף');
    if (text.includes('בשר') || text.includes('beef')) recipe.tags.push('בשר');
    if (text.includes('גריל') || text.includes('grill')) recipe.tags.push('גריל');
    if (text.includes('אסייתי') || text.includes('asian')) recipe.tags.push('אסייתי');
    if (text.includes('מרינדה') || text.includes('marinade')) recipe.tags.push('מרינדה');
    if (text.includes('צ\'ילי') || text.includes('chili')) recipe.tags.push('צ\'ילי');
    if (text.includes('דל') && (text.includes('שומן') || text.includes('קלוריות'))) recipe.tags.push('דל שומן');
    if (text.includes('חלבון')) recipe.tags.push('עשיר בחלבון');
    if (text.includes('נינג\'ה')) recipe.tags.push('נינג\'ה גריל');
    if (text.includes('מהיר') || (recipe.cookMinutes && recipe.cookMinutes <= 15)) recipe.tags.push('מהיר');
  }

  // Infer times
  const prepMatch = content.match(/(\d+)\s*דק.*הכנה|הכנ.*?(\d+)\s*דק/);
  const cookMatch = content.match(/(\d+)[-–]?(\d+)?\s*דקות.*צלייה|צלי.*?(\d+)[-–]?(\d+)?\s*דקות|(\d+)[-–](\d+)\s*דקות סה"כ/);

  if (content.includes('נינג\'ה גריל') || content.includes('ninja')) {
    if (!recipe.prepMinutes) recipe.prepMinutes = 25; // 20 min marinade + 5 min prep
    if (!recipe.cookMinutes) recipe.cookMinutes = 10;
  }

  // Infer difficulty
  if (recipe.steps.length <= 3 || (recipe.cookMinutes && recipe.cookMinutes <= 15)) {
    recipe.difficulty = 'קל';
  } else if (recipe.steps.length >= 7 || (recipe.cookMinutes && recipe.cookMinutes >= 60)) {
    recipe.difficulty = 'בינוני';
  }

  return recipe;
}

function parseIngredient(text) {
  // Pattern: "name — qty unit (note)" or "name — qty unit, note"
  const parts = text.split(/\s*[—–-]\s*/);
  const name = parts[0]?.trim();
  if (!name) return null;

  const item = { name };

  if (parts[1]) {
    const rest = parts[1].trim();
    // Try to extract qty and unit
    const qtyMatch = rest.match(/^([\d.½¼¾⅓⅔]+(?:[-–][\d.½¼¾⅓⅔]+)?)\s*(\S+)?/);
    if (qtyMatch) {
      let qty = qtyMatch[1].replace('½', '0.5').replace('¼', '0.25').replace('¾', '0.75');
      // Handle ranges - take average
      if (qty.includes('-') || qty.includes('–')) {
        const [a, b] = qty.split(/[-–]/).map(Number);
        qty = (a + b) / 2;
      }
      item.qty = parseFloat(qty) || null;
      if (qtyMatch[2]) item.unit = qtyMatch[2];
    }

    // Extract note from parentheses or after comma
    const noteMatch = rest.match(/\(([^)]+)\)/);
    if (noteMatch) item.note = noteMatch[1];
    else {
      const commaNote = rest.match(/,\s*(.+)/);
      if (commaNote) item.note = commaNote[1];
    }
  }

  return item;
}

function recipeToFrontmatter(recipe) {
  const yaml = [];
  yaml.push('---');
  yaml.push(`title: "${recipe.title}"`);
  if (recipe.emoji) yaml.push(`emoji: "${recipe.emoji}"`);
  if (recipe.description) yaml.push(`description: "${recipe.description}"`);
  yaml.push(`version: "${recipe.version}"`);
  yaml.push(`date: "${recipe.date}"`);
  yaml.push(`servings: ${recipe.servings}`);
  if (recipe.prepMinutes) yaml.push(`prepMinutes: ${recipe.prepMinutes}`);
  if (recipe.cookMinutes) yaml.push(`cookMinutes: ${recipe.cookMinutes}`);
  yaml.push(`difficulty: "${recipe.difficulty}"`);
  yaml.push(`tags: ${JSON.stringify(recipe.tags)}`);

  yaml.push('nutrition:');
  yaml.push(`  calories: ${recipe.nutrition.calories}`);
  yaml.push(`  protein: ${recipe.nutrition.protein}`);
  yaml.push(`  carbs: ${recipe.nutrition.carbs}`);
  yaml.push(`  fat: ${recipe.nutrition.fat}`);
  if (recipe.nutrition.fiber) yaml.push(`  fiber: ${recipe.nutrition.fiber}`);

  yaml.push('ingredientGroups:');
  for (const group of recipe.ingredientGroups) {
    yaml.push(`  - title: "${group.title}"`);
    yaml.push('    items:');
    for (const item of group.items) {
      let line = `      - { name: "${item.name}"`;
      if (item.qty != null) line += `, qty: ${item.qty}`;
      if (item.unit) line += `, unit: "${item.unit}"`;
      if (item.note) line += `, note: "${item.note}"`;
      line += ' }';
      yaml.push(line);
    }
  }

  yaml.push('steps:');
  for (const step of recipe.steps) {
    yaml.push(`  - ${JSON.stringify(step)}`);
  }

  const arrayFields = ['serving', 'equipment', 'storage', 'nextTime'];
  for (const field of arrayFields) {
    if (recipe[field]?.length) {
      yaml.push(`${field}:`);
      for (const item of recipe[field]) {
        yaml.push(`  - "${item.replace(/"/g, '\\"')}"`);
      }
    }
  }

  if (recipe.journal?.length) {
    yaml.push('journal:');
    for (const entry of recipe.journal) {
      yaml.push(`  - version: "${entry.version}"`);
      yaml.push(`    date: "${entry.date}"`);
      if (entry.rating) yaml.push(`    rating: ${entry.rating}`);
      if (entry.worked) yaml.push(`    worked: "${entry.worked}"`);
      if (entry.improve) yaml.push(`    improve: "${entry.improve}"`);
      if (entry.changes) yaml.push(`    changes: "${entry.changes}"`);
      if (entry.notes) yaml.push(`    notes: "${entry.notes.replace(/"/g, '\\"')}"`);
    }
  }

  yaml.push('---');
  yaml.push('');

  // Add body text (description)
  if (recipe.description) {
    yaml.push(recipe.description);
  }

  return yaml.join('\n');
}

function syncRecipes() {
  // Ensure target dir exists
  if (!fs.existsSync(SITE_RECIPES)) {
    fs.mkdirSync(SITE_RECIPES, { recursive: true });
  }

  const files = fs.readdirSync(WORKSPACE_RECIPES)
    .filter(f => f.endsWith('.md') && f !== 'README.md');

  let changed = false;

  for (const file of files) {
    const srcPath = path.join(WORKSPACE_RECIPES, file);
    const destPath = path.join(SITE_RECIPES, file);

    const srcContent = fs.readFileSync(srcPath, 'utf8');
    const srcMtime = fs.statSync(srcPath).mtimeMs;

    // Check if dest exists and is newer
    if (fs.existsSync(destPath)) {
      const destMtime = fs.statSync(destPath).mtimeMs;
      // If source hasn't changed since last sync, skip
      const syncMarker = path.join(SITE_ROOT, '.last-sync');
      if (fs.existsSync(syncMarker)) {
        const lastSync = fs.statSync(syncMarker).mtimeMs;
        if (srcMtime < lastSync) continue;
      }
    }

    // Check if source already has frontmatter (already in Astro format)
    if (srcContent.startsWith('---')) {
      // Already formatted, copy as-is
      fs.copyFileSync(srcPath, destPath);
      console.log(`📋 Copied (already formatted): ${file}`);
      changed = true;
      continue;
    }

    // Parse and convert
    console.log(`🔄 Converting: ${file}`);
    const recipe = parseRecipe(srcContent, file);
    const output = recipeToFrontmatter(recipe);
    fs.writeFileSync(destPath, output, 'utf8');
    console.log(`✅ Converted: ${file} → ${recipe.title} (${recipe.servings} servings, ${recipe.nutrition.calories} cal)`);
    changed = true;
  }

  // Update sync marker
  fs.writeFileSync(path.join(SITE_ROOT, '.last-sync'), new Date().toISOString());

  return changed;
}

function deploy() {
  console.log('\n🚀 Building & deploying...');
  try {
    execSync('npm run build', { cwd: SITE_ROOT, stdio: 'inherit' });
    // Try git push first, fall back to SWA CLI
    try {
      execSync('git add -A && git diff --cached --quiet || git commit -m "🍽️ sync recipes" && git push', {
        cwd: SITE_ROOT, stdio: 'inherit'
      });
      console.log('✅ Pushed to GitHub → auto-deploy will handle it');
    } catch {
      console.log('⚠️ Git push failed, deploying directly via SWA CLI...');
      const token = fs.existsSync(path.join(SITE_ROOT, '.swa-token')) ? fs.readFileSync(path.join(SITE_ROOT, '.swa-token'), 'utf8').trim() : process.env.SWA_DEPLOYMENT_TOKEN || '';
      execSync(`npx @azure/static-web-apps-cli deploy ./dist --deployment-token ${token}`, {
        cwd: SITE_ROOT, stdio: 'inherit'
      });
    }
    console.log('✅ Deploy complete!');
  } catch (e) {
    console.error('❌ Deploy failed:', e.message);
    process.exit(1);
  }
}

// Main
const watch = process.argv.includes('--watch');

console.log('🍽️ Recipe Sync');
console.log(`📂 Source: ${WORKSPACE_RECIPES}`);
console.log(`📂 Target: ${SITE_RECIPES}\n`);

const changed = syncRecipes();
if (changed) {
  deploy();
} else {
  console.log('✨ Nothing to sync, all recipes up to date.');
}

if (watch) {
  console.log('\n👀 Watching for changes...');
  fs.watch(WORKSPACE_RECIPES, { persistent: true }, (eventType, filename) => {
    if (!filename?.endsWith('.md') || filename === 'README.md') return;
    console.log(`\n📝 Change detected: ${filename}`);
    setTimeout(() => {
      const changed = syncRecipes();
      if (changed) deploy();
    }, 1000); // Debounce
  });
}
