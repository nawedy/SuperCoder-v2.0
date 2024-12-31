import React from 'react';
import PricingSection from '../components/subscription/PricingSection';

export default function Subscription() {
  return (
    <div className="min-h-screen bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <PricingSection />
      </div>
    </div>
  );
}