import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { supabase } from './lib/supabase';
import Navbar from './components/Navbar';
import Landing from './pages/Landing';
import AuthForm from './components/AuthForm';
import Dashboard from './pages/Dashboard';
import Subscription from './pages/Subscription';

function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      {session && <Navbar />}
      <Routes>
        <Route
          path="/"
          element={session ? <Navigate to="/dashboard" /> : <Landing />}
        />
        <Route
          path="/auth"
          element={session ? <Navigate to="/dashboard" /> : <AuthForm />}
        />
        <Route
          path="/dashboard"
          element={session ? <Dashboard /> : <Navigate to="/auth" />}
        />
        <Route
          path="/subscription"
          element={session ? <Subscription /> : <Navigate to="/auth" />}
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;