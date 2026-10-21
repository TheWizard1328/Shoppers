export const createClientFromRequest = () => ({
  auth: { me: async () => ({ id: 'owner-test', email: 'a@b.c' }) },
  asServiceRole: { entities: { AppUser: { filter: async () => ([{ is_app_owner: true, app_roles: ['app_owner'] }]) } } },
  entities: {},
  functions: { invoke: async () => ({}) },
});
