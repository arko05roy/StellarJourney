"use client";

import { useRef, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function LandingMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".hero-copy > *", {
          opacity: 0,
          y: 28,
          duration: 0.9,
          stagger: 0.08,
          ease: "power3.out",
        });

        gsap.from(".hero-visual", {
          opacity: 0,
          scale: 0.92,
          duration: 1.15,
          ease: "power3.out",
        });

        gsap.utils.toArray<HTMLElement>(".reveal").forEach((element) => {
          gsap.from(element, {
            opacity: 0,
            y: 34,
            duration: 0.8,
            ease: "power3.out",
            scrollTrigger: {
              trigger: element,
              start: "top 86%",
              once: true,
            },
          });
        });

        gsap.fromTo(
          ".reveal-word",
          { opacity: 0.12 },
          {
            opacity: 1,
            stagger: 0.08,
            ease: "none",
            scrollTrigger: {
              trigger: ".reveal-word",
              start: "top 82%",
              end: "bottom 42%",
              scrub: 0.8,
            },
          },
        );
      });

      media.add("(min-width: 768px) and (prefers-reduced-motion: no-preference)", () => {
        const cards = gsap.utils.toArray<HTMLElement>(".stack-card");
        const lastCard = cards.at(-1);

        if (!lastCard) return;

        cards.forEach((card, index) => {
          const nextCard = cards[index + 1];

          if (!nextCard) return;

          ScrollTrigger.create({
            trigger: card,
            start: "top 96px",
            endTrigger: lastCard,
            end: "top 96px",
            pin: true,
            pinSpacing: false,
          });

          gsap.to(card, {
            opacity: 0,
            scale: 0.92,
            ease: "none",
            scrollTrigger: {
              trigger: nextCard,
              start: "top bottom",
              end: "top 96px",
              scrub: true,
            },
          });
        });
      });

      return () => media.revert();
    },
    { scope: root },
  );

  return <div ref={root}>{children}</div>;
}
