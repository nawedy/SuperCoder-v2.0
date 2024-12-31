import React from 'react';
import TestimonialCard from './TestimonialCard';

const testimonials = [
  {
    name: 'Sarah Chen',
    role: 'Senior Developer',
    company: 'TechCorp',
    image: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=150&h=150',
    content: 'SuperCoder has transformed our development workflow. The AI assistance is incredibly accurate and the natural language processing makes coding feel intuitive.',
  },
  {
    name: 'James Wilson',
    role: 'CTO',
    company: 'StartupX',
    image: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=150&h=150',
    content: 'The productivity gains we\'ve seen since implementing SuperCoder are remarkable. It\'s like having an expert pair programmer available 24/7.',
  },
  {
    name: 'Emily Rodriguez',
    role: 'Lead Engineer',
    company: 'InnovateLabs',
    image: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=150&h=150',
    content: 'SuperCoder\'s ability to understand complex requirements and generate accurate code is impressive. It\'s become an essential part of our development toolkit.',
  },
];

export default function TestimonialsSection() {
  return (
    <div className="py-12 sm:py-16 px-4 sm:px-6 lg:px-8">
      <div className="text-center mb-8 sm:mb-12">
        <h2 className="text-2xl sm:text-3xl font-bold text-white">What Our Users Say</h2>
        <p className="mt-4 text-base sm:text-lg text-gray-400">
          Join thousands of developers who are coding smarter with SuperCoder
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
        {testimonials.map((testimonial) => (
          <TestimonialCard key={testimonial.name} {...testimonial} />
        ))}
      </div>
    </div>
  );
}