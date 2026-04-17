import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const ingredientItem = z.object({
  name: z.string(),
  qty: z.number().nullable().optional(),
  unit: z.string().optional(),
  note: z.string().optional(),
  scalable: z.boolean().default(true),
});

const ingredientGroup = z.object({
  title: z.string(),
  items: z.array(ingredientItem),
});

const journalEntry = z.object({
  version: z.string(),
  date: z.string(),
  rating: z.number().optional(),
  worked: z.string().optional(),
  improve: z.string().optional(),
  changes: z.string().optional(),
  notes: z.string().optional(),
});

const recipes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/recipes' }),
  schema: z.object({
    title: z.string(),
    emoji: z.string().optional(),
    description: z.string().optional(),
    version: z.string().default('v1'),
    date: z.string(),
    servings: z.number(),
    prepMinutes: z.number().optional(),
    cookMinutes: z.number().optional(),
    difficulty: z.enum(['קל', 'בינוני', 'מאתגר']).default('בינוני'),
    tags: z.array(z.string()).default([]),
    image: z.string().optional(),
    nutrition: z.object({
      calories: z.number(),
      protein: z.number(),
      carbs: z.number(),
      fat: z.number(),
      fiber: z.number().optional(),
    }),
    ingredientGroups: z.array(ingredientGroup),
    steps: z.array(z.string()),
    serving: z.array(z.string()).optional(),
    equipment: z.array(z.string()).optional(),
    storage: z.array(z.string()).optional(),
    nextTime: z.array(z.string()).optional(),
    journal: z.array(journalEntry).optional(),
  }),
});

export const collections = { recipes };
