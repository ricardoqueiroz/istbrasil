import { Component, OnInit, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule, Table, TableLazyLoadEvent } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { Obra, ObraService } from '../../../services/obra.service';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
    selector: 'app-obra',
    standalone: true,
    imports: [
        CommonModule,
        TableModule,
        InputTextModule,
        ButtonModule,
        FooterWidget
    ],
    templateUrl: './obra.component.html',
    styleUrls: ['./obra.component.scss']
})
export class ObraComponent implements OnInit {

    @ViewChild('dt') dt: Table | undefined;

    obras: Obra[] = [];
    totalRecords: number = 0;
    loading: boolean = true;
    rows: number = 25;
    
    private searchSubject: Subject<string> = new Subject<string>();
    private lastLazyLoadEvent: TableLazyLoadEvent = {};

    constructor(private obraService: ObraService, private cd: ChangeDetectorRef) { }

    ngOnInit(): void {
        this.searchSubject.pipe(
            debounceTime(500),
            distinctUntilChanged()
        ).subscribe(searchValue => {
            if (this.dt) {
                this.dt.filter(searchValue, 'titulo', 'contains');
            }
        });
    }

    loadObras(event: TableLazyLoadEvent): void {
        this.lastLazyLoadEvent = event;
        this.loading = true;
        const page = (event.first || 0) / (event.rows || this.rows) + 1;
        const limit = event.rows || this.rows;
        const search = (event.filters && event.filters['titulo']) ? (event.filters['titulo'] as any).value : '';
        const sortField = event.sortField as string | undefined;
        const sortOrder = event.sortOrder === null ? undefined : event.sortOrder;

        this.obraService.getObras(page, limit, search, sortField, sortOrder).subscribe(response => {
            this.obras = response.data;
            this.totalRecords = response.total;
            this.loading = false;
            this.cd.markForCheck();
        });
    }

    onFilter(event: Event): void {
        const input = event.target as HTMLInputElement;
        this.searchSubject.next(input.value);
    }

    clear(table: Table): void {
        table.clear();
        const searchInput = document.getElementById('search-input') as HTMLInputElement;
        if (searchInput) {
            searchInput.value = '';
        }
        this.searchSubject.next('');
        // Manually trigger a reload with the cleared filter
        const clearedEvent: TableLazyLoadEvent = { ...this.lastLazyLoadEvent, first: 0, filters: {} };
        this.loadObras(clearedEvent);
    }
}
