import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get Square access token from secrets
    const accessToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
    if (!accessToken) {
      return Response.json({ error: 'Square access token not configured' }, { status: 500 });
    }

    // Get all active Square location configs
    const configs = await base44.entities.SquareLocationConfig.filter({ status: 'active' });
    
    if (!configs || configs.length === 0) {
      return Response.json({ locations: [], message: 'No active Square locations configured' });
    }

    // Fetch location details from Square for each config
    const locationBalances = [];
    
    for (const config of configs) {
      try {
        // Fetch location details from Square Locations API
        const locationResponse = await fetch(
          `https://connect.squareup.com/v2/locations/${config.square_location_id}`,
          {
            method: 'GET',
            headers: {
              'Square-Version': '2024-01-18',
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (locationResponse.ok) {
          const locationData = await locationResponse.json();
          const location = locationData.location;

          // Fetch balance from Payments API - get recent payments summary
          // Note: Square doesn't have a direct "balance" endpoint, but we can get
          // the location's cash drawer shift or use Bank Accounts API for connected accounts
          
          let balance = null;
          let currency = location?.currency || 'CAD';

          // Try to get bank account balance if available
          try {
            const bankAccountsResponse = await fetch(
              `https://connect.squareup.com/v2/bank-accounts`,
              {
                method: 'GET',
                headers: {
                  'Square-Version': '2024-01-18',
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json'
                }
              }
            );

            if (bankAccountsResponse.ok) {
              const bankData = await bankAccountsResponse.json();
              // Find primary bank account
              const primaryBank = bankData.bank_accounts?.find(b => b.primary_bank_identification_number);
              if (primaryBank) {
                balance = primaryBank.balance?.amount ? primaryBank.balance.amount / 100 : null;
              }
            }
          } catch (bankError) {
            console.log('Bank accounts not available:', bankError.message);
          }

          locationBalances.push({
            configId: config.id,
            configName: config.name,
            squareLocationId: config.square_location_id,
            locationName: location?.name || config.name,
            status: location?.status || 'UNKNOWN',
            currency: currency,
            balance: balance,
            businessName: location?.business_name,
            address: location?.address ? 
              `${location.address.address_line_1 || ''}, ${location.address.locality || ''}, ${location.address.administrative_district_level_1 || ''}`.trim().replace(/^,\s*|,\s*$/g, '') 
              : null,
            timezone: location?.timezone,
            capabilities: location?.capabilities || [],
            merchantId: location?.merchant_id
          });
        } else {
          const errorText = await locationResponse.text();
          console.error(`Failed to fetch location ${config.square_location_id}:`, errorText);
          locationBalances.push({
            configId: config.id,
            configName: config.name,
            squareLocationId: config.square_location_id,
            error: `Failed to fetch: ${locationResponse.status}`,
            status: 'ERROR'
          });
        }
      } catch (locError) {
        console.error(`Error fetching location ${config.square_location_id}:`, locError);
        locationBalances.push({
          configId: config.id,
          configName: config.name,
          squareLocationId: config.square_location_id,
          error: locError.message,
          status: 'ERROR'
        });
      }
    }

    return Response.json({ 
      locations: locationBalances,
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error in getSquareLocationBalances:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});