import React from 'react';
import { Link } from 'react-router-dom';
import { Terminal } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function Navbar() {
  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <nav className="bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <Link to="/" className="flex items-center space-x-2">
              <Terminal className="h-8 w-8 text-emerald-500" />
              <span className="text-xl font-bold">SuperCoder</span>
            </Link>
          </div>
          <div className="flex items-center space-x-4">
            <button
              onClick={handleSignOut}
              className="bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-md text-sm font-medium"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}