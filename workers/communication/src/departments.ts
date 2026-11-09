import { all, one } from "./db";
import {
  type Env,
  type Actor,
  type Conversation,
  ApiError,
  json,
  requireValue,
} from "./types";

export async function validateDepartments(
  env: Env,
  profile: string,
  departments: any,
) {
  requireValue(
    Array.isArray(departments) && departments.length <= 100,
    "Use até 100 setores de atendimento.",
  );
  const ids = new Set<string>();
  for (const department of departments) {
    requireValue(
      typeof department?.id === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(department.id) &&
        !ids.has(department.id),
      "Identificador de setor inválido ou repetido.",
    );
    ids.add(department.id);
    requireValue(
      department.enabled === undefined ||
        typeof department.enabled === "boolean",
      "Informe se o setor está habilitado ou desabilitado.",
    );
    requireValue(
      typeof department.name === "string" &&
        department.name.trim().length > 0 &&
        department.name.length <= 100,
      "Informe o nome do setor.",
    );
    requireValue(
      Array.isArray(department.members) &&
        department.members.length <= 100 &&
        new Set(department.members).size === department.members.length,
      "Selecione até 100 pessoas, sem repetir.",
    );
    for (const member of department.members)
      requireValue(
        typeof member === "string" &&
          (await one(
            env,
            "SELECT id FROM users WHERE id=? AND disabled=0 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?))",
            member,
            profile,
          )),
        "Uma pessoa do setor não está autorizada neste perfil.",
      );
  }
}

export async function departmentFor(
  env: Env,
  profile: string,
  id?: string | null,
) {
  if (!id) return null;
  const profileRow = await one(
    env,
    "SELECT settings FROM profiles WHERE id=?",
    profile,
  );
  return (
    (json(profileRow?.settings).departments || []).find(
      (d: any) => d.id === id && d.enabled !== false,
    ) || null
  );
}

export async function assertDepartmentAccess(
  env: Env,
  actor: Actor,
  c: Conversation,
) {
  if (!c.department_id || actor.role === "admin") return;
  if(actor.fagoo) {
    if(actor.fagoo.administrator || actor.fagoo.teamIds.includes(c.department_id)) return;
    throw new ApiError(403,'department_access_denied','Setor não autorizado.');
  }
  const department = await departmentFor(env, c.profile_id, c.department_id);
  if (actor.kind !== "user" || !department?.members.includes(actor.id))
    throw new ApiError(
      403,
      "department_access_denied",
      "Esta conversa aguarda uma pessoa do setor responsável.",
    );
}

export async function presentInDepartment(
  env: Env,
  profile: string,
  id?: string | null,
) {
  const department = await departmentFor(env, profile, id);
  if (id && !department) return null;
  const present = await all(
    env,
    "SELECT p.actor,u.role,u.profiles FROM presence p JOIN users u ON u.id=p.actor AND u.disabled=0 WHERE p.profile_id=? AND p.present=1 ORDER BY p.updated,p.actor",
    profile,
  );
  return (
    present.find(
      (person) =>
        (person.role === "admin" ||
          json(person.profiles, []).includes(profile)) &&
        (!department || department.members.includes(person.actor)),
    ) || null
  );
}
