import React from 'react';
import PricingCard from './PricingCard';

const plans = [
  {
    title: 'Basic',
    price: '0',
    features: [
      { text: 'Access to GPT-3.5', included: true },
      { text: 'Basic code completion', included: true },
      { text: 'Community support', included: true },
      { text: 'Custom AI models', included: false },
      { text: 'Priority support', included: false },
    ],
  },
  {
    title: 'Pro',
    price: '19',
    features: [
      { text: 'Access to GPT-4', included: true },
      { text: 'Advanced code completion', included: true },
      { text: 'Priority support', included: true },
      { text: 'Custom AI models', included: true },
      { text: 'Team collaboration', included: false },
    ],
    isPopular: true,
  },
  {
    title: 'Enterprise',
    price: '49',
    features: [
      { text: 'Access to all AI models', included: true },
      { text: 'Advanced code completion', included: true },
      { text: 'Priority support', included: true },
      { text: 'Custom AI models', included: true },
      { text: 'Team collaboration', included: true },
    ],
  },
];

export default function PricingSection() {
  const handleSelectPlan = (planTitle: string) => {
    // Handle plan selection
    console.log(`Selected plan: ${planTitle}`);
  };

  return (
    <div className="py-12 sm:py-16 px-4 sm:px-6 lg:px-8">
      <div className="text-center">
        <h2 className="text-2xl sm:text-3xl font-bold text-white">Choose Your Plan</h2>
        <p className="mt-4 text-base sm:text-lg text-gray-400">
          Select the perfect plan for your development needs
        </p>
      </div>
      <div className="mt-8 sm:mt-12 grid gap-6 sm:gap-8 md:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => (
          <PricingCard
            key={plan.title}
            title={plan.title}
            price={plan.price}
            features={plan.features}
            isPopular={plan.isPopular}
            onSelect={() => handleSelectPlan(plan.title)}
          />
        ))}
      </div>
    </div>
  );
}