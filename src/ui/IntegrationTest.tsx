// Summary: New React component that tests and displays results from backend integrations.
import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle } from 'lucide-react';

const IntegrationTest: React.FC = () => {
  const [apiResponse, setApiResponse] = useState<string>('Loading...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Simulated test run calling backend API gateway
    fetch('/api/test') // Ensure that your backend is routed for /api/test
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((data) => {
        setApiResponse(JSON.stringify(data, null, 2));
      })
      .catch((err) => {
        setError(err.message);
      });
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gray-50">
      <div className="max-w-3xl w-full bg-white shadow-md rounded-lg p-6">
        <h1 className="text-2xl font-bold mb-4 flex items-center">
          {error ? (
            <>
              <AlertCircle className="w-6 h-6 text-red-500 mr-2" />
              Error during Integration Test
            </>
          ) : (
            <>
              <CheckCircle className="w-6 h-6 text-green-500 mr-2" />
              Integration Test Success
            </>
          )}
        </h1>
        <pre className="bg-gray-100 p-4 rounded overflow-x-auto text-sm">
          {error ? error : apiResponse}
        </pre>
      </div>
    </div>
  );
};

export default IntegrationTest;
