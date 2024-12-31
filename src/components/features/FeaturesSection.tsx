import React from 'react';
import {
  Terminal,
  Code2,
  Cpu,
  Zap,
  GitBranch,
  Shield,
  Users,
  Globe,
  Clock
} from 'lucide-react';
import FeatureCard from './FeatureCard';

const features = [
  {
    icon: <Terminal className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "Natural Language Interface",
    description: "Code naturally using conversational language or terminal commands"
  },
  {
    icon: <Code2 className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "Multi-File Support",
    description: "Handle complex projects spanning multiple files and directories"
  },
  {
    icon: <Cpu className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "AI-Powered",
    description: "Leverage advanced AI to automate and enhance your coding"
  },
  {
    icon: <Zap className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "Real-Time Assistance",
    description: "Get instant code suggestions and error fixes as you type"
  },
  {
    icon: <GitBranch className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "Version Control Integration",
    description: "Seamlessly integrate with your existing Git workflow"
  },
  {
    icon: <Shield className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "Secure Development",
    description: "Enterprise-grade security with encrypted communications"
  },
  {
    icon: <Users className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "Team Collaboration",
    description: "Share code snippets and solutions within your team"
  },
  {
    icon: <Globe className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "Multi-Language Support",
    description: "Support for all major programming languages and frameworks"
  },
  {
    icon: <Clock className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />,
    title: "24/7 Availability",
    description: "Access AI assistance whenever you need it, day or night"
  }
];

export default function FeaturesSection() {
  return (
    <div className="mt-12 sm:mt-16 lg:mt-20 px-4 sm:px-6 lg:px-8">
      <h2 className="text-2xl sm:text-3xl font-bold text-white text-center mb-8 sm:mb-12">
        Why Choose SuperCoder?
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
        {features.map((feature, index) => (
          <FeatureCard
            key={index}
            icon={feature.icon}
            title={feature.title}
            description={feature.description}
          />
        ))}
      </div>
    </div>
  );
}