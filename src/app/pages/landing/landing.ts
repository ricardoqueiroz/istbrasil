import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { RippleModule } from 'primeng/ripple';
import { StyleClassModule } from 'primeng/styleclass';
import { ButtonModule } from 'primeng/button';
import { DividerModule } from 'primeng/divider';
import { AppTopbar } from 'src/app/layout/component/app.topbar';
import { HeroWidget } from './components/herowidget';
import { FeaturesWidget } from './components/featureswidget';
import { HighlightsWidget } from './components/highlightswidget';
import { PricingWidget } from './components/pricingwidget';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
    selector: 'app-landing',
    standalone: true,
    imports: [RouterModule, AppTopbar, HeroWidget, FeaturesWidget, HighlightsWidget, PricingWidget, FooterWidget, RippleModule, StyleClassModule, ButtonModule, DividerModule],
    template: `
        <div class="bg-surface-0 dark:bg-surface-900">
            <div id="home" class="landing-wrapper overflow-hidden">
                <app-topbar [showMenuButton]="false" />
                <hero-widget />
                <section class="mx-6 my-8 md:mx-20" aria-labelledby="festival-cta-title">
                    <a routerLink="/eventos/ii-festival-de-violoes-sebastiao-tapajos" class="mx-auto block w-full max-w-[800px] overflow-hidden rounded-3xl border border-emerald-200 bg-emerald-50 text-center shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-500">
                        <img src="/assets/images/eventos/festival-violoes-banner.jpg" alt="II Festival de Violões Sebastião Tapajós" class="block h-auto w-full" />
                        <div class="p-6 md:p-8">
                            <span class="block text-sm font-semibold uppercase tracking-widest text-emerald-700">Inscreva-se no</span>
                            <span id="festival-cta-title" class="mt-2 block text-2xl font-bold text-emerald-950 md:text-3xl">II Festival de Violões Sebastião Tapajós</span>
                        </div>
                    </a>
                </section>
                <features-widget />
                <highlights-widget />
                <pricing-widget />
                <footer-widget />
            </div>
        </div>
    `
})
export class Landing {}
