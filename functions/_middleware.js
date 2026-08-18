import { getSessionUser } from "./_utils.js";

export async function onRequest(context) {
  const user = await getSessionUser(context.request, context.env);
  context.data.user = user; // null if not logged in
  return context.next();
}
