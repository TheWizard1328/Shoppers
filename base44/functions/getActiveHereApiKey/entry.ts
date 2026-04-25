import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SECRET_NAME_MAP = {
  HERE_API_KEY: 'HERE_API_KEY',
  Here_API_Key_2: 'Here_API_Key_2',
  Here_API_Key_3: 'Here_API_Key_3'
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
    const settingValue = settings?.[0]?.setting_value || {};
    const selectedSecretName = settingValue.selected_api_key || settingValue.selected_here_api_key || 'HERE_API_KEY';
    const resolvedSecretName = SECRET_NAME_MAP[selectedSecretName] || 'HERE_API_KEY';
    const apiKey = Deno.env.get(resolvedSecretName);

    if (!apiKey) {
      return Response.json({ error: `Missing HERE API key secret: ${resolvedSecretName}` }, { status: 500 });
    }

    return Response.json({ secretName: resolvedSecretName, apiKey });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});