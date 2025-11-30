import React, { useState, useEffect } from "react";
import { User } from "@/entities/User";
import { Patient } from "@/entities/Patient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { getEffectiveUser } from "./auth";

export default function AuthDiagnostics() {
  const [diagnostics, setDiagnostics] = useState(null);
  const [loading, setLoading] = useState(true);

  const runDiagnostics = async () => {
    setLoading(true);
    const results = {
      timestamp: new Date().toISOString(),
      tests: []
    };

    // Test 1: User.me()
    try {
      const userMe = await User.me();
      results.tests.push({
        name: "User.me()",
        status: "success",
        data: userMe,
        message: `Logged in as: ${userMe?.full_name || 'Unknown'}`
      });
      results.currentUser = userMe;
    } catch (error) {
      results.tests.push({
        name: "User.me()",
        status: "error",
        error: error.message,
        message: "Failed to get current user"
      });
    }

    // Test 2: getEffectiveUser()
    try {
      const effectiveUser = await getEffectiveUser();
      results.tests.push({
        name: "getEffectiveUser()",
        status: "success",
        data: effectiveUser,
        message: `Effective user: ${effectiveUser?.full_name || 'Unknown'}`
      });
      results.effectiveUser = effectiveUser;
    } catch (error) {
      results.tests.push({
        name: "getEffectiveUser()",
        status: "error",
        error: error.message,
        message: "Failed to get effective user"
      });
    }

    // Test 3: User.list()
    try {
      const users = await User.list();
      results.tests.push({
        name: "User.list()",
        status: "success",
        data: `${users?.length || 0} users`,
        message: `Can access ${users?.length || 0} user records`
      });
    } catch (error) {
      results.tests.push({
        name: "User.list()",
        status: "error",
        error: error.message,
        message: "Cannot access user list"
      });
    }

    // Test 4: Patient.list()
    try {
      const patients = await Patient.list();
      results.tests.push({
        name: "Patient.list()",
        status: "success",
        data: `${patients?.length || 0} patients`,
        message: `Can access ${patients?.length || 0} patient records`
      });
    } catch (error) {
      results.tests.push({
        name: "Patient.list()",
        status: "error",
        error: error.message,
        message: "Cannot access patient list - This is the main issue!"
      });
    }

    // Test 5: Check user fields
    if (results.currentUser) {
      const requiredFields = ['app_role', 'store_ids', 'id', 'email'];
      const missingFields = requiredFields.filter(field => !results.currentUser[field]);
      
      if (missingFields.length === 0) {
        results.tests.push({
          name: "User Fields Check",
          status: "success",
          data: {
            app_role: results.currentUser.app_role,
            store_ids: results.currentUser.store_ids,
            id: results.currentUser.id
          },
          message: "All required user fields present"
        });
      } else {
        results.tests.push({
          name: "User Fields Check",
          status: "warning",
          data: { missing: missingFields },
          message: `Missing fields: ${missingFields.join(', ')}`
        });
      }
    }

    setDiagnostics(results);
    setLoading(false);
  };

  useEffect(() => {
    runDiagnostics();
  }, []);

  if (loading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardContent className="pt-6">
          <div className="flex items-center justify-center gap-2">
            <RefreshCw className="w-5 h-5 animate-spin" />
            <span>Running diagnostics...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Authentication Diagnostics</span>
          <Button onClick={runDiagnostics} size="sm" variant="outline">
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {diagnostics?.tests.map((test, idx) => (
            <div key={idx} className="border rounded-lg p-4">
              <div className="flex items-start gap-3">
                {test.status === 'success' && <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />}
                {test.status === 'error' && <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />}
                {test.status === 'warning' && <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />}
                
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-sm">{test.name}</h4>
                  <p className="text-sm text-slate-600 mt-1">{test.message}</p>
                  
                  {test.error && (
                    <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                      <strong>Error:</strong> {test.error}
                    </div>
                  )}
                  
                  {test.data && typeof test.data === 'object' && (
                    <details className="mt-2">
                      <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                        View details
                      </summary>
                      <pre className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded text-xs overflow-auto max-h-40">
                        {JSON.stringify(test.data, null, 2)}
                      </pre>
                    </details>
                  )}
                  
                  {test.data && typeof test.data === 'string' && (
                    <p className="mt-1 text-xs text-slate-500">{test.data}</p>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded">
            <h4 className="font-semibold text-sm text-blue-900 mb-2">Summary</h4>
            <p className="text-sm text-blue-700">
              Successful: {diagnostics?.tests.filter(t => t.status === 'success').length} / {diagnostics?.tests.length}
            </p>
            {diagnostics?.tests.some(t => t.status === 'error') && (
              <p className="text-sm text-red-700 mt-2">
                <strong>Action needed:</strong> Contact support with this diagnostic report
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}