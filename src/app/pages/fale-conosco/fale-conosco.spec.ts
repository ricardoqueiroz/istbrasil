import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FaleConosco } from './fale-conosco';

describe('FaleConosco', () => {
  let component: FaleConosco;
  let fixture: ComponentFixture<FaleConosco>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FaleConosco]
    })
    .compileComponents();

    fixture = TestBed.createComponent(FaleConosco);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
