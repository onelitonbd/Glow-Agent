import { randomUUID } from 'node:crypto';
import { conflict, notFound } from '../lib/errors.js';
import { identifier, requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';

function toSkill(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function duplicateSkill(error) {
  if (error?.message?.includes('UNIQUE constraint failed')) {
    throw conflict('A skill with this name already exists.');
  }
  throw error;
}

export function listSkills(db) {
  return db.prepare('SELECT * FROM skills ORDER BY updated_at DESC').all().map(toSkill);
}

export function getSkill(db, rawSkillId) {
  const skillId = identifier(rawSkillId, 'Skill ID');
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  if (!row) throw notFound('Skill');
  return toSkill(row);
}

function values(body) {
  return {
    name: requiredString(body.name, 'Name', { max: 80 }),
    description: requiredString(body.description, 'Description', { max: 280 }),
    instructions: requiredString(body.instructions, 'Instructions', { max: 12_000 })
  };
}

export function createSkill(db, body) {
  const { name, description, instructions } = values(body);
  const id = randomUUID();
  const timestamp = now();
  try {
    db.prepare(`INSERT INTO skills (id, name, description, instructions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name, description, instructions, timestamp, timestamp);
  } catch (error) {
    duplicateSkill(error);
  }
  return getSkill(db, id);
}

export function updateSkill(db, rawSkillId, body) {
  const skillId = identifier(rawSkillId, 'Skill ID');
  if (!db.prepare('SELECT 1 FROM skills WHERE id = ?').get(skillId)) throw notFound('Skill');
  const { name, description, instructions } = values(body);
  try {
    db.prepare(`UPDATE skills SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?`)
      .run(name, description, instructions, now(), skillId);
  } catch (error) {
    duplicateSkill(error);
  }
  return getSkill(db, skillId);
}

export function deleteSkill(db, rawSkillId) {
  const skillId = identifier(rawSkillId, 'Skill ID');
  const result = db.prepare('DELETE FROM skills WHERE id = ?').run(skillId);
  if (Number(result.changes) === 0) throw notFound('Skill');
}
