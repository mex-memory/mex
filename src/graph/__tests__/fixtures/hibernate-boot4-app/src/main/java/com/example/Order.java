package com.example;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToOne;

@Entity
public class Order {
  @Id
  private Long id;

  @ManyToOne
  private Widget widget;
}
