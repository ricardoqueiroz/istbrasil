import { BootstrapOptions, provideZoneChangeDetection } from '@angular/core';
import { AppComponent } from './app.component';
import { appRoutes } from './app.routes';
import { provideRouter } from '@angular/router';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection(),
    provideRouter(appRoutes),
    provideAnimations()
  ]
}).catch((err: unknown) => console.error(err));
