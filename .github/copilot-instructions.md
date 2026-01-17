
# AI Coding Instructions for istbrasil.org.br

## Project Architecture

- **Frontend**: Angular 20 (Sakai NG template) using standalone components, PrimeNG, and Tailwind CSS. Source in `src/app/`. Routing is lazy-loaded; UI is built with PrimeNG and utility classes from Tailwind. See `src/app/routes/` and `src/app/pages/` for feature modules and page components.
- **Backend (Node.js/Express)**: API server entry is `server.js` at project root. API routes are in `src/routes/` (JavaScript), delegating to controllers in `src/controllers/`. Database access uses `mysql2/promise` via `src/config/db.js`.
- **Legacy PHP**: Admin and support scripts in `development/` and `html/` (notably `istdbadmin/`). Maintain only if required; new features should use Node/Angular.
- **Database**: MySQL, with schema and view definitions in `database/`. Use `src/config/db.js` for connection pooling.

## Key Patterns & Conventions

- **Mixed Source Roots**: Both backend (`.js`) and frontend (`.ts`) code live under `src/`. Always check file extensions and directory context.
- **Angular**: Uses Angular 19+ standalone components. Prefer `@Component({standalone: true})` and direct imports. UI composition is via PrimeNG modules and Tailwind classes. See `src/app/pages/` for examples.
- **Routing**: Angular routes are defined in `src/app.routes.ts` and feature route files. Use lazy loading for large modules.
- **Backend**: API endpoints are defined in `src/routes/`, with business logic in `src/controllers/`. Use async/await and `mysql2/promise` for DB access.
- **Legacy**: PHP code in `development/` and `html/` is only updated for bugfixes or admin needs. Prefer Node/Angular for all new work.

## Developer Workflows

- **Frontend Dev**: `ng serve` (Angular dev server, port 4200). Hot reload is enabled.
- **Backend Dev**: `node server.js` (Express API, port 3000).
- **Database Test**: `node test-db.js` to verify DB connectivity.
- **Build**: `ng build` (output in `dist/`).
- **Unit Tests**: `ng test` (Karma runner).
- **E2E Tests**: `ng e2e` (choose your own framework).

## Project-Specific Notes

- **Linting/Formatting**: ESLint config in `eslint.config.js` enforces Angular and Prettier rules. Component selectors use `p-` prefix by convention.
- **Styling**: Tailwind is used for utility classes, but core layout uses custom CSS. See `src/assets/layout/variables` for theme variables.
- **Environment**: Windows/IIS. Use absolute paths (e.g., `c:\inetpub\wwwroot\istbrasil.org.br`).
- **Admin Interface**: Legacy admin is in `html/istdbadmin/` and `development/admin/`. Only update if explicitly requested.
- **Data Flow**: Angular frontend calls Node API (`/api/*`), which queries MySQL. Avoid direct DB access from frontend.

## Key Files & Directories

- `server.js`: Express server entry
- `src/app/`: Angular app source
- `src/routes/`: Express API routes (JS)
- `src/controllers/`: Express controllers (JS)
- `src/config/db.js`: MySQL connection
- `database/`: SQL schemas/views
- `development/`, `html/`: Legacy PHP

## Examples

- **Angular Standalone Component**: See `src/app/pages/editora/editora.component.ts` for a typical standalone component using PrimeNG and Tailwind.
- **API Route**: See `src/routes/` and `src/controllers/` for Express route/controller pattern.
- **Theme Customization**: See `src/assets/layout/variables` and `src/app/layout/` for theming.

---
Keep instructions concise and focused on actual project practices. Update this file if major structure or workflow changes.