# AI Coding Instructions for istbrasil.org.br

## Architecture Overview
This is a hybrid web application with a modern Angular frontend and a lightweight Node.js/Express backend, co-existing with legacy PHP components.
- **Frontend**: Angular 20 (Sakai NG template) with PrimeNG and Tailwind CSS. Located in `src/app`. It uses standalone components and lazy loading for routing.
- **Backend (Node)**: Express.js server entry point is `server.js` at root. API routes are in `src/routes/` which delegate business logic to controllers in `src/controllers/`.
- **Backend (Legacy PHP)**: Existing PHP admin and support scripts in `development/` and `html/`. Maintain if requested but prefer Node/Angular for new features.
- **Database**: MySQL. Connection logic in `src/config/db.js`.

## Codebase Patterns & Conventions
- **Backend Location**: Unlike standard practices, Node.js backend routes, controllers, and config currently reside in `src/` alongside Angular source. Be careful to distinguish `.js` (backend) from `.ts` (frontend) files in `src/`.
- **Angular Stack**: Uses Standalone Components (Angular 19+ style). PrimeNG is the primary UI library; Tailwind is used for utility classes.
- **Data Access**: `mysql2` with promise support is used for database interactions within the controller files.

## Key Files & Directories
- `server.js`: Main Express server entry point.
- `src/app/`: Angular frontend application code.
- `src/routes/`: Express API route definitions (Javascript).
- `src/controllers/`: Express controller files with business logic.
- `src/config/db.js`: Database configuration and connection pool.
- `database/`: SQL schemas and views.
- `istdbadmin/`: Legacy PHP admin interface.

## Development Workflow
- **Frontend**: Run `ng serve` to start the Angular dev server (default port 4200).
- **Backend**: Run `node server.js` to start the API server (default port 3000).
- **Database Testing**: Run `node test-db.js` to verify connectivity.
- **Building**: Run `ng build` to build the project for production.
- **Testing**: Run `ng test` to run unit tests.

## Environment
- **OS**: Windows (IIS environment).
- **Paths**: Project root is `c:\inetpub\wwwroot\istbrasil.org.br`. Use absolute paths or standard node module resolution.